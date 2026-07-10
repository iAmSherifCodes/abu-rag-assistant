/**
 * REST API stack for the ABU Conversational AI Assistant.
 *
 * Exposes a single, API-key-protected endpoint:
 *
 *     POST /ask       { "query": "How do I apply for admission to ABU?" }
 *     POST /documents { "fileName": "admissions.pdf" }  -> presigned upload URL
 *     POST /ingest    -> start a knowledge-base ingestion job
 *     GET  /ingest    -> status of recent ingestion jobs
 *
 * The /ask request is forwarded to a Lambda that retrieves the most relevant
 * chunks from the Bedrock Knowledge Base and calls the first-party Anthropic
 * Claude API to write a grounded answer. The /documents and /ingest routes let
 * clients add documents to the knowledge base and (re)index them.
 */
import * as path from 'path';
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AbuAssistantApiStackProps extends StackProps {
  /** ID of the Bedrock Knowledge Base the Lambda retrieves from. */
  readonly knowledgeBaseId: string;
  /** The S3 bucket documents are uploaded to. */
  readonly documentBucket: s3.IBucket;
  /** ID of the knowledge base data source that indexes the document bucket. */
  readonly dataSourceId: string;
  /**
   * Claude model to generate answers with. Defaults to Claude Opus 4.8.
   * Use e.g. `claude-haiku-4-5` for a cheaper/faster option on this
   * high-volume, extractive Q&A workload.
   */
  readonly claudeModel?: string;
}

export class AbuAssistantApiStack extends Stack {
  constructor(scope: Construct, id: string, props: AbuAssistantApiStackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // Secret holding the Anthropic API key
    // ------------------------------------------------------------------
    // Created empty; populate it after deploy with the real key, e.g.:
    //   aws secretsmanager put-secret-value \
    //     --secret-id abu-assistant/anthropic-api-key \
    //     --secret-string 'sk-ant-...'
    const anthropicApiKeySecret = new secretsmanager.Secret(this, 'AnthropicApiKey', {
      secretName: 'abu-assistant/anthropic-api-key',
      description: 'Anthropic API key used by the ABU assistant Lambda',
    });

    // ------------------------------------------------------------------
    // Lambda: retrieve from the knowledge base, then call the Claude API
    // ------------------------------------------------------------------
    const invokeAssistantLambda = new NodejsFunction(this, 'InvokeAbuAssistant', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambda', 'invoke-assistant.ts'),
      handler: 'handler',
      timeout: Duration.minutes(4),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        ANTHROPIC_SECRET_ARN: anthropicApiKeySecret.secretArn,
        MODEL_ID: props.claudeModel ?? 'claude-opus-4-8',
      },
      bundling: {
        minify: true,
        // The AWS SDK v3 is provided by the Node.js 20 runtime, so it does not
        // need to be bundled. The Anthropic SDK is not, so it IS bundled.
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Let the function read the Anthropic API key.
    anthropicApiKeySecret.grantRead(invokeAssistantLambda);

    // Allow the function to retrieve from the Bedrock Knowledge Base.
    invokeAssistantLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:Retrieve'],
        resources: [
          Stack.of(this).formatArn({
            service: 'bedrock',
            resource: 'knowledge-base',
            resourceName: props.knowledgeBaseId,
          }),
        ],
      }),
    );

    // ------------------------------------------------------------------
    // Lambda: presigned document uploads + ingestion control
    // ------------------------------------------------------------------
    const documentLambda = new NodejsFunction(this, 'DocumentManager', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambda', 'upload-document.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        DOCUMENT_BUCKET: props.documentBucket.bucketName,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
      },
      bundling: {
        minify: true,
        // Bundle the SDK packages (S3 presigner and Bedrock Agent control
        // plane) so they are guaranteed to be present regardless of which
        // clients the runtime happens to bundle.
        externalModules: [],
      },
    });

    // Allow the function to write objects to the document bucket. The presigned
    // PUT URLs it issues inherit this permission.
    props.documentBucket.grantPut(documentLambda);

    // Allow the function to start and inspect knowledge-base ingestion jobs.
    documentLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:StartIngestionJob',
          'bedrock:GetIngestionJob',
          'bedrock:ListIngestionJobs',
        ],
        resources: [
          Stack.of(this).formatArn({
            service: 'bedrock',
            resource: 'knowledge-base',
            resourceName: props.knowledgeBaseId,
          }),
        ],
      }),
    );

    // ------------------------------------------------------------------
    // API Gateway  -  secured with an API key, throttling and a quota
    // ------------------------------------------------------------------
    const api = new apigw.RestApi(this, 'AbuAssistantRestApi', {
      restApiName: 'abu-assistant-api',
      description: 'Secure REST API for the ABU document-grounded AI assistant',
      deployOptions: {
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
    });

    const apiKey = api.addApiKey('AbuAssistantApiKey', {
      apiKeyName: 'AbuAssistantApiKey',
      description: 'API key for secure access to the ABU assistant',
    });

    const usagePlan = api.addUsagePlan('AbuAssistantUsagePlan', {
      name: 'AbuAssistantUsagePlan',
      throttle: { rateLimit: 50, burstLimit: 100 },
      quota: { limit: 10000, period: apigw.Period.MONTH },
    });
    usagePlan.addApiStage({ stage: api.deploymentStage });
    usagePlan.addApiKey(apiKey);

    // CORS so the web frontend can call the API directly from the browser.
    // The OPTIONS preflight is a MOCK integration and needs no API key;
    // the POST itself still requires one. Tighten allowOrigins to the
    // frontend's domain once it has a fixed URL.
    const askResource = api.root.addResource('ask', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'x-api-key'],
      },
    });

    // POST /ask  ->  invoke assistant Lambda
    askResource.addMethod('POST', new apigw.LambdaIntegration(invokeAssistantLambda), {
      apiKeyRequired: true,
    });

    const cors = {
      allowOrigins: apigw.Cors.ALL_ORIGINS,
      allowHeaders: ['Content-Type', 'x-api-key'],
    };

    // POST /documents  ->  return a presigned S3 upload URL
    const documentsResource = api.root.addResource('documents', {
      defaultCorsPreflightOptions: { ...cors, allowMethods: ['POST', 'OPTIONS'] },
    });
    documentsResource.addMethod('POST', new apigw.LambdaIntegration(documentLambda), {
      apiKeyRequired: true,
    });

    // POST /ingest -> start ingestion;  GET /ingest -> recent job status
    const ingestResource = api.root.addResource('ingest', {
      defaultCorsPreflightOptions: { ...cors, allowMethods: ['POST', 'GET', 'OPTIONS'] },
    });
    ingestResource.addMethod('POST', new apigw.LambdaIntegration(documentLambda), {
      apiKeyRequired: true,
    });
    ingestResource.addMethod('GET', new apigw.LambdaIntegration(documentLambda), {
      apiKeyRequired: true,
    });

    // Errors generated by API Gateway itself (e.g. 403 for a bad API key)
    // bypass the Lambda, so attach the CORS header here too or the browser
    // will mask them as opaque network errors.
    const corsErrorHeaders = {
      'Access-Control-Allow-Origin': "'*'",
      'Access-Control-Allow-Headers': "'Content-Type,x-api-key'",
    };
    api.addGatewayResponse('Default4xxWithCors', {
      type: apigw.ResponseType.DEFAULT_4XX,
      responseHeaders: corsErrorHeaders,
    });
    api.addGatewayResponse('Default5xxWithCors', {
      type: apigw.ResponseType.DEFAULT_5XX,
      responseHeaders: corsErrorHeaders,
    });

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId });
  }
}
