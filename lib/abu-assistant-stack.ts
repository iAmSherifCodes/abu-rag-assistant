/**
 * Core RAG stack for the ABU Conversational AI Assistant.
 *
 * Architecture
 * ------------
 *     ABU Q&A PDF (S3 document bucket)
 *         -> Bedrock Knowledge Base (chunk + embed with Titan Text Embeddings)
 *         -> Amazon S3 Vectors index (the vector database)
 *
 * Generation is *not* handled by a Bedrock Agent. Instead the REST API Lambda
 * retrieves the most relevant chunks from this knowledge base (via the Bedrock
 * `Retrieve` API) and passes them to the first-party Anthropic Claude API,
 * which writes the grounded answer. This "retrieve-then-read" split keeps the
 * assistant *document-grounded* while using the Claude API directly.
 */
import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { bedrock, s3vectors } from '@cdklabs/generative-ai-cdk-constructs';

/** Provisions the vector database and knowledge base used for retrieval. */
export class AbuAssistantStack extends Stack {
  public readonly knowledgeBase: bedrock.VectorKnowledgeBase;
  public readonly documentBucket: s3.Bucket;
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // 1. Embeddings model
    // ------------------------------------------------------------------
    // Amazon Titan Text Embeddings V2 produces 1024-dimensional vectors.
    // The vector index dimension MUST match this model's output dimension.
    const embeddingsModel = bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024;

    // ------------------------------------------------------------------
    // 2. Vector database  -  Amazon S3 Vectors
    // ------------------------------------------------------------------
    // A vector bucket is the native, low-cost vector storage in S3.
    const vectorBucket = new s3vectors.VectorBucket(this, 'AbuVectorBucket', {
      encryption: s3vectors.VectorBucketEncryption.S3_MANAGED,
    });

    // A vector index holds the embeddings for similarity search.
    // `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` are reserved
    // metadata keys that Bedrock writes alongside each vector; they must be
    // declared non-filterable so they are stored but not indexed for filters.
    const vectorIndex = new s3vectors.VectorIndex(this, 'AbuVectorIndex', {
      vectorBucket,
      dimension: embeddingsModel.vectorDimensions!,
      distanceMetric: s3vectors.VectorIndexDistanceMetric.COSINE,
      dataType: s3vectors.VectorIndexDataType.FLOAT_32,
      nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
    });

    // ------------------------------------------------------------------
    // 3. Knowledge base grounded on the S3 Vectors index
    // ------------------------------------------------------------------
    const knowledgeBase = new bedrock.VectorKnowledgeBase(this, 'AbuKnowledgeBase', {
      name: 'AbuKnowledgeBase',
      vectorStore: vectorIndex,
      embeddingsModel,
      instruction:
        'Answer questions about Ahmadu Bello University (ABU), Zaria: ' +
        'admissions, registration, faculties, fees, academic calendar ' +
        'and student support. Only use the retrieved ABU documents.',
    });
    this.knowledgeBase = knowledgeBase;

    // ------------------------------------------------------------------
    // 4. Document source  -  the ABU Q&A PDF lives in this S3 bucket
    // ------------------------------------------------------------------
    const documentBucket = new s3.Bucket(this, 'AbuDocumentBucket', {
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Presigned-URL uploads from the web frontend PUT bytes straight to S3
      // (bypassing API Gateway), so the browser needs this CORS rule or the
      // upload is blocked by the preflight check. Tighten allowedOrigins to the
      // frontend's domain once it has a fixed URL.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });
    this.documentBucket = documentBucket;

    // Wire the document bucket into the knowledge base as a data source.
    // Any number of supported documents (PDF, TXT, MD, DOCX, HTML, CSV, XLSX)
    // placed in this bucket are chunked, embedded and indexed on ingestion.
    // The REST API exposes endpoints to upload documents and start ingestion.
    const dataSource = new bedrock.S3DataSource(this, 'AbuDocumentDataSource', {
      bucket: documentBucket,
      knowledgeBase,
      dataSourceName: 'abu-qa-documents',
      chunkingStrategy: bedrock.ChunkingStrategy.FIXED_SIZE,
    });
    this.dataSourceId = dataSource.dataSourceId;

    // ------------------------------------------------------------------
    // 5. Helpful outputs
    // ------------------------------------------------------------------
    // The generation persona (system prompt) now lives in the REST API Lambda,
    // which calls the Claude API directly with the retrieved excerpts.
    new CfnOutput(this, 'DocumentBucketName', { value: documentBucket.bucketName });
    new CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.knowledgeBaseId });
  }
}
