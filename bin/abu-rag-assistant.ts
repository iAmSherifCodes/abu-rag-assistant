#!/usr/bin/env node
/**
 * CDK application entry point for the ABU Document-Grounded Conversational AI Assistant.
 *
 * This app defines two stacks:
 *
 * 1. `AbuAssistantStack` - the RAG core: an Amazon S3 Vectors store and a
 *    Bedrock Knowledge Base grounded on the ABU Q&A document.
 * 2. `AbuAssistantApiStack` - a secured REST API (API Gateway + Lambda) that
 *    retrieves from the knowledge base and calls the Claude API to answer.
 */
import * as cdk from 'aws-cdk-lib';
import { AbuAssistantStack } from '../lib/abu-assistant-stack';
import { AbuAssistantApiStack } from '../lib/rest-api-stack';

const app = new cdk.App();

// RAG core: knowledge base + vector store.
const assistantStack = new AbuAssistantStack(app, 'AbuAssistantStack');

// The API stack needs the Knowledge Base ID. By default this is wired as a
// CloudFormation cross-stack reference. It can be overridden with a plain
// value via context (`-c knowledgeBaseId=...`), which decouples the two
// stacks — useful when migrating away from the previous Bedrock Agent, whose
// exported ID would otherwise block the core stack from being updated.
const knowledgeBaseId =
  app.node.tryGetContext('knowledgeBaseId') ?? assistantStack.knowledgeBase.knowledgeBaseId;

// Public-facing REST API that retrieves from the KB and calls the Claude API,
// and also exposes endpoints to upload documents and start ingestion.
new AbuAssistantApiStack(app, 'AbuAssistantApiStack', {
  knowledgeBaseId,
  documentBucket: assistantStack.documentBucket,
  dataSourceId: assistantStack.dataSourceId,
});

app.synth();
