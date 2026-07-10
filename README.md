# ABU Document-Grounded Conversational AI Assistant

**Building a Document-Grounded Conversational AI Assistant for Ahmadu Bello University Using RAG and Vector Databases**

A serverless, document-grounded conversational assistant for Ahmadu Bello
University (ABU), Zaria. It answers questions about the university (admissions,
registration, faculties, fees, academic calendar, hostels, student support,
etc.) using **Retrieval-Augmented Generation (RAG)** over a compiled ABU Q&A
document, with **Amazon S3 Vectors** as the vector database.

Built with the **AWS Cloud Development Kit (CDK)** in TypeScript (Node.js) and
**Amazon Bedrock** (Knowledge Bases + Agents).

---

## 1. What problem does it solve?

Prospective and current ABU students repeatedly ask the same questions through
many channels. A general-purpose chatbot would *hallucinate* answers. This
assistant is **document-grounded**: it only answers from the institution's own
Q&A document. Every response is generated from text retrieved from that
document, which keeps answers accurate, traceable and easy to update (just
re-upload the document).

## 2. How RAG works here

```
            ┌──────────────────────────────────────────────────────────────┐
            │                     INGESTION (one-time / on update)          │
            │                                                                │
   ABU Q&A  │   S3 Document Bucket ──► Bedrock Knowledge Base                │
    PDF ───►│        (raw PDF)          • split into chunks                  │
            │                           • embed each chunk (Titan V2, 1024-d)│
            │                           • store vectors ──► S3 Vectors index │
            └──────────────────────────────────────────────────────────────┘

            ┌──────────────────────────────────────────────────────────────┐
            │                        QUERY (per question)                   │
            │                                                                │
   User ───►│  API Gateway ──► Lambda ──► Bedrock Agent                      │
  question  │  (API key)                    │                               │
            │                               ├─► embed question              │
            │                               ├─► similarity search in        │
            │                               │   S3 Vectors (top-k chunks)    │
            │                               ├─► Claude composes a grounded   │
            │                               │   answer from those chunks     │
            │◄──────────────────────────────┘                               │
            │           grounded natural-language answer                     │
            └──────────────────────────────────────────────────────────────┘
```

- **Retrieval** – the user's question is embedded and compared against the
  document chunk vectors in the S3 Vectors index (cosine similarity).
- **Augmentation** – the most relevant chunks are injected into the prompt.
- **Generation** – Anthropic Claude (on Bedrock) writes the final answer using
  *only* those chunks. If nothing relevant is found, it says so instead of
  guessing.

## 3. Architecture & AWS services

| Layer | Service | Role |
|-------|---------|------|
| Vector database | **Amazon S3 Vectors** (`VectorBucket` + `VectorIndex`) | Stores and searches the document embeddings (the project's "vector database"). |
| Knowledge base | **Amazon Bedrock Knowledge Base** | Chunks the document, generates embeddings (Titan Text Embeddings V2), and manages retrieval. |
| Embeddings model | **Amazon Titan Text Embeddings V2** (1024-d) | Converts text to vectors. |
| Reasoning model | **Anthropic Claude 3.5 Sonnet** (on Bedrock) | The conversational agent that composes grounded answers. |
| Orchestration | **Amazon Bedrock Agent** | Ties retrieval + generation together with the assistant's instructions. |
| API | **Amazon API Gateway** (REST, API-key protected, throttled, quota'd) | Secure public entry point. |
| Compute | **AWS Lambda** (Node.js 20) | Invokes the agent and returns the answer. |
| IaC | **AWS CDK** (TypeScript) | Defines and deploys all of the above. |

### Stacks

- **`AbuAssistantStack`** (`lib/abu-assistant-stack.ts`) — the RAG core: S3 Vectors
  store, knowledge base, document bucket, and the Bedrock agent.
- **`AbuAssistantApiStack`** (`lib/rest-api-stack.ts`) — the secured REST API and
  the Lambda that invokes the agent.

## 4. Project structure

```
abu-rag-assistant/
├── bin/
│   └── abu-rag-assistant.ts            # CDK app entry point (wires the two stacks)
├── lib/
│   ├── abu-assistant-stack.ts          # S3 Vectors + Knowledge Base + Bedrock Agent
│   └── rest-api-stack.ts               # API Gateway + Lambda (secured /ask endpoint)
├── lambda/
│   └── invoke-assistant.ts             # Invokes the Bedrock agent, returns the answer
├── content/                            # Put your ABU Q&A PDF here (source copy)
├── test/                               # Synthesis tests (jest)
├── package.json                        # CDK / Node.js dependencies
├── tsconfig.json                       # TypeScript configuration
└── cdk.json                            # CDK toolkit configuration
```

## 5. Prerequisites

- An AWS account with **Amazon Bedrock model access enabled** in your region for
  *Anthropic Claude 3.5 Sonnet* and *Amazon Titan Text Embeddings V2*
  (Bedrock console → Model access).
- **Amazon S3 Vectors** available in your chosen region (e.g. `us-east-1`).
- AWS CLI configured (`aws configure`). The **AWS CDK** CLI is included as a dev
  dependency and is run via `npx cdk` (no global install required).
- **Node.js 20+** recommended (matches the Lambda runtime).
- The Lambda is bundled with `esbuild` (installed as a dependency); no Docker is
  required for bundling.

## 6. Setup

```bash
cd abu-rag-assistant

# Install dependencies
npm install
```

## 7. Add your ABU Q&A document

1. Keep a copy of your compiled Q&A PDF in `content/` (for your records).
2. The actual ingestion happens from the **document S3 bucket** created by the
   stack. After deploying (next step), upload the PDF there:

   ```bash
   aws s3 cp content/ABU_DLC_QA.pdf s3://<DocumentBucketName>/
   ```

   `<DocumentBucketName>` is printed as a CloudFormation output after deploy.

## 8. Deploy

```bash
npx cdk bootstrap          # first time only, per account/region
npx cdk deploy --all
```

Note the outputs:
- `AbuAssistantStack.DocumentBucketName`, `KnowledgeBaseId`
- `AbuAssistantApiStack.ApiUrl`, `ApiKeyId`

## 9. Ingest the document (build the vector index)

After uploading the PDF, start a Bedrock **ingestion (sync) job** so the
document is chunked, embedded and written into the S3 Vectors index. Either:

- **Console:** Bedrock → Knowledge bases → *AbuKnowledgeBase* → select the data
  source → **Sync**, **or**
- **CLI:** start an ingestion job for the knowledge base / data source IDs shown
  in the console.

Re-run this sync whenever you update the Q&A document.

## 10. Ask a question

Retrieve the API key value (the output is the key *ID*, not the secret):

```bash
aws apigateway get-api-key --api-key <ApiKeyId> --include-value --query value --output text
```

Then call the endpoint:

```bash
curl -X POST "<ApiUrl>ask" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY_VALUE>" \
  -d '{"query": "How do I apply for undergraduate admission to ABU?"}'
```

Example response:

```json
{
  "message": "Success",
  "answer": "To apply for undergraduate admission to ABU, ..."
}
```

## 11. Run the tests

```bash
npm test
```

## 12. Clean up

```bash
npx cdk destroy --all
```

## 13. Notes for the project report

- **Why RAG?** It grounds a large language model in authoritative ABU content,
  eliminating hallucination and making the knowledge updatable without
  retraining any model.
- **Why a vector database?** Natural-language questions rarely match document
  wording word-for-word. Embeddings capture *meaning*, and the vector index
  enables fast *semantic* similarity search over the document chunks.
- **Why Amazon S3 Vectors?** It is a native, low-cost vector store that
  integrates directly with Bedrock Knowledge Bases — a good fit for a
  student/academic project where keeping infrastructure cost low matters.
- **Security:** the API requires an API key and applies rate limiting and a
  monthly quota; the document and vector buckets block all public access.

---

*Final-year project — Ahmadu Bello University.*
