/**
 * Lambda handler for document management on the ABU assistant knowledge base.
 *
 * Routes (all behind API Gateway, API-key protected):
 *
 *   POST /documents   { "fileName": "admissions.pdf" }
 *       -> returns a short-lived presigned S3 URL. The client then uploads the
 *          file directly to S3 with an HTTP PUT to that URL. Keeping the bytes
 *          out of API Gateway/Lambda supports files far larger than the ~10 MB
 *          API Gateway payload limit (up to the Bedrock ~50 MB document limit).
 *
 *   POST /ingest      (no body)
 *       -> starts a Bedrock ingestion job so newly uploaded documents are
 *          chunked, embedded and indexed into the knowledge base.
 *
 *   GET  /ingest      (no body)
 *       -> returns the status of recent ingestion jobs.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BedrockAgentClient,
  StartIngestionJobCommand,
  ListIngestionJobsCommand,
} from '@aws-sdk/client-bedrock-agent';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const region = process.env.AWS_REGION ?? 'us-east-1';
const s3 = new S3Client({ region });
const bedrockAgent = new BedrockAgentClient({ region });

const DOCUMENT_BUCKET = process.env.DOCUMENT_BUCKET;
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID;
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID;

// Presigned upload URLs are valid for 15 minutes.
const UPLOAD_URL_TTL_SECONDS = 900;

// Formats Amazon Bedrock knowledge bases can parse.
const ALLOWED_EXTENSIONS = [
  'pdf', 'txt', 'md', 'html', 'doc', 'docx', 'csv', 'xls', 'xlsx',
];

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function respond(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return { statusCode, body: JSON.stringify(body), headers: JSON_HEADERS };
}

/** Strip any path components and keep a safe, S3-friendly object key. */
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.trim().replace(/[^A-Za-z0-9._-]/g, '_');
}

async function handleCreateUpload(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = event.body ? JSON.parse(event.body) : {};
  const rawName = body.fileName;

  if (!rawName || !String(rawName).trim()) {
    return respond(400, { message: "Bad Request: 'fileName' is required" });
  }

  const fileName = sanitizeFileName(String(rawName));
  const extension = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';

  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return respond(400, {
      message: `Bad Request: unsupported file type '.${extension}'`,
      allowed: ALLOWED_EXTENSIONS,
    });
  }

  // Generate a presigned PUT URL. Content-Type is intentionally not signed, so
  // the client can PUT the file without matching a specific header; Bedrock
  // determines how to parse the document from its file extension.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: DOCUMENT_BUCKET, Key: fileName }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );

  return respond(200, {
    message: 'Success',
    key: fileName,
    uploadUrl,
    method: 'PUT',
    expiresIn: UPLOAD_URL_TTL_SECONDS,
    note:
      'Upload the file with an HTTP PUT to uploadUrl, then call POST /ingest ' +
      'to index it into the knowledge base.',
  });
}

async function handleStartIngestion(): Promise<APIGatewayProxyResult> {
  const result = await bedrockAgent.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
    }),
  );
  const job = result.ingestionJob;
  return respond(202, {
    message: 'Ingestion started',
    ingestionJobId: job?.ingestionJobId,
    status: job?.status,
  });
}

async function handleListIngestion(): Promise<APIGatewayProxyResult> {
  const result = await bedrockAgent.send(
    new ListIngestionJobsCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
      sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
      maxResults: 5,
    }),
  );
  const jobs = (result.ingestionJobSummaries ?? []).map((j) => ({
    ingestionJobId: j.ingestionJobId,
    status: j.status,
    startedAt: j.startedAt,
    documentsScanned: j.statistics?.numberOfDocumentsScanned,
    documentsIndexed: j.statistics?.numberOfNewDocumentsIndexed,
  }));
  return respond(200, { message: 'Success', jobs });
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const resource = event.resource; // e.g. '/documents' or '/ingest'
    const method = event.httpMethod;

    if (resource === '/documents' && method === 'POST') {
      return await handleCreateUpload(event);
    }
    if (resource === '/ingest' && method === 'POST') {
      return await handleStartIngestion();
    }
    if (resource === '/ingest' && method === 'GET') {
      return await handleListIngestion();
    }
    return respond(404, { message: `Not Found: ${method} ${resource}` });
  } catch (exc) {
    return respond(500, {
      message: 'Internal Server Error',
      error: exc instanceof Error ? exc.message : String(exc),
    });
  }
};
