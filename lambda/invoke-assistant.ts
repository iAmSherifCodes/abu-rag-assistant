/**
 * Lambda handler for the ABU assistant (retrieve-then-read RAG).
 *
 * It receives a JSON body `{"query": "..."}` from API Gateway, then:
 *   1. Retrieves the most relevant chunks from the Bedrock Knowledge Base
 *      (which is backed by the S3 Vectors store) via the `Retrieve` API.
 *   2. Sends those chunks, plus the question, to the first-party Anthropic
 *      Claude API, which writes a grounded answer.
 *
 * Generation is no longer done by a Bedrock Agent / Bedrock foundation model —
 * it calls the Claude API directly.
 */
import middy from '@middy/core';
import { Logger } from '@aws-lambda-powertools/logger';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import Anthropic from '@anthropic-ai/sdk';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const logger = new Logger({ serviceName: 'abu_assistant' });
const tracer = new Tracer({ serviceName: 'abu_assistant' });

const region = process.env.AWS_REGION ?? 'us-east-1';

const bedrockAgentRuntimeClient = tracer.captureAWSv3Client(
  new BedrockAgentRuntimeClient({ region }),
);
const secretsClient = tracer.captureAWSv3Client(
  new SecretsManagerClient({ region }),
);

const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID;
const ANTHROPIC_SECRET_ARN = process.env.ANTHROPIC_SECRET_ARN;
const MODEL_ID = process.env.MODEL_ID ?? 'claude-opus-4-8';

// How many knowledge-base chunks to retrieve per question.
const RETRIEVAL_RESULTS = 5;

// The generation persona. The assistant answers ONLY from the retrieved
// excerpts, which is what keeps it document-grounded.
const SYSTEM_PROMPT = [
  'You are the Ahmadu Bello University (ABU) virtual assistant. ',
  'You help prospective and current students, parents and staff by ',
  'answering questions about the university using ONLY the retrieved ',
  'ABU knowledge-base excerpts provided in the user message. ',
  'Be clear, polite and concise. Respond with just the answer, no preamble. ',
  'If the answer is not contained in the excerpts, say that you do not have ',
  'that information and suggest contacting the relevant ABU office, instead ',
  'of guessing. Do not invent policies, dates, fees or contact details.',
].join('');

// The CORS origin must also be sent on the real (non-preflight) response;
// API Gateway's preflight config does not cover Lambda proxy responses.
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function buildResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return { statusCode, body: JSON.stringify(body), headers: JSON_HEADERS };
}

// Cache the Anthropic client across warm invocations so the API-key secret is
// fetched only once per container.
let anthropicClientPromise: Promise<Anthropic> | undefined;

function getAnthropicClient(): Promise<Anthropic> {
  if (!anthropicClientPromise) {
    anthropicClientPromise = (async () => {
      const secret = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: ANTHROPIC_SECRET_ARN }),
      );
      const apiKey = secret.SecretString?.trim();
      if (!apiKey) {
        throw new Error('Anthropic API key secret is empty — populate it before use');
      }
      return new Anthropic({ apiKey });
    })().catch((err) => {
      // Don't cache a failed lookup — allow the next invocation to retry.
      anthropicClientPromise = undefined;
      throw err;
    });
  }
  return anthropicClientPromise;
}

const lambdaHandler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const query = body.query;
    logger.info(`User query: ${query}`);

    // Validate input
    if (!query || !String(query).trim()) {
      return buildResponse(400, { message: "Bad Request: 'query' field is required" });
    }

    // 1. Retrieve relevant chunks from the Bedrock Knowledge Base (S3 Vectors).
    const retrieval = await bedrockAgentRuntimeClient.send(
      new RetrieveCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        retrievalQuery: { text: String(query) },
        retrievalConfiguration: {
          vectorSearchConfiguration: { numberOfResults: RETRIEVAL_RESULTS },
        },
      }),
    );

    const passages = (retrieval.retrievalResults ?? [])
      .map((result) => result.content?.text)
      .filter((text): text is string => Boolean(text && text.trim()));

    // Nothing relevant in the knowledge base — don't hallucinate an answer.
    if (passages.length === 0) {
      return buildResponse(200, {
        message: 'Success',
        answer:
          "I don't have that information in my knowledge base. " +
          'Please contact the relevant ABU office.',
      });
    }

    const context = passages
      .map((passage, index) => `[Excerpt ${index + 1}]\n${passage}`)
      .join('\n\n');

    // 2. Ask Claude to answer using ONLY the retrieved excerpts.
    const anthropic = await getAnthropicClient();
    const completion = await anthropic.messages.create({
      model: MODEL_ID,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `Retrieved ABU knowledge-base excerpts:\n\n${context}\n\n` +
            `Question: ${String(query)}`,
        },
      ],
    });

    const answer = completion.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    return buildResponse(200, { message: 'Success', answer });
  } catch (exc) {
    // Surface a clean 500 to the client.
    logger.error('Unhandled error while invoking the assistant', exc as Error);
    return buildResponse(500, {
      message: 'Internal Server Error',
      error: exc instanceof Error ? exc.message : String(exc),
    });
  }
};

export const handler = middy(lambdaHandler)
  .use(captureLambdaHandler(tracer))
  .use(injectLambdaContext(logger));
