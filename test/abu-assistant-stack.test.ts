/**
 * Basic synthesis tests for the ABU assistant stacks.
 *
 * These confirm the CloudFormation templates synthesize and contain the key
 * resources (the knowledge base and the secured REST API). Generation is done
 * via the Claude API in the Lambda, so there is no longer a Bedrock Agent.
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template } from 'aws-cdk-lib/assertions';
import { AbuAssistantStack } from '../lib/abu-assistant-stack';
import { AbuAssistantApiStack } from '../lib/rest-api-stack';

test('assistant stack creates a knowledge base and no agent', () => {
  const app = new cdk.App();
  const stack = new AbuAssistantStack(app, 'TestAbuAssistantStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::Bedrock::KnowledgeBase', 1);
  template.resourceCountIs('AWS::Bedrock::Agent', 0);
  // The ABU document source bucket.
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

test('api stack requires an api key and holds the Anthropic key secret', () => {
  const app = new cdk.App();
  const infra = new cdk.Stack(app, 'TestInfra');
  const documentBucket = new s3.Bucket(infra, 'TestDocBucket');
  const apiStack = new AbuAssistantApiStack(app, 'TestAbuAssistantApiStack', {
    knowledgeBaseId: 'TESTKBID',
    dataSourceId: 'TESTDSID',
    documentBucket,
  });
  const template = Template.fromStack(apiStack);

  template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
  // The Anthropic API key is stored in Secrets Manager.
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  // Two Lambdas: the assistant and the document manager.
  template.resourceCountIs('AWS::Lambda::Function', 2);
  // The /ask method must require an API key.
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'POST',
    ApiKeyRequired: true,
  });
});
