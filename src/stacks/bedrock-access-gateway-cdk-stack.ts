import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { LambdaTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import path = require('path');

export class BedrockAccessGatewayCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Parameters
    const apiKeySecretArn = new cdk.CfnParameter(this, 'ApiKeySecretArn', {
      type: 'String',
      allowedPattern: '^arn:aws:secretsmanager:.*$',
      description: 'The secret ARN in Secrets Manager used to store the API Key',
    });

    const defaultModelId = new cdk.CfnParameter(this, 'DefaultModelId', {
      type: 'String',
      description: 'The default model ID, please make sure the model ID is supported in the current region',
      default: 'anthropic.claude-3-sonnet-20240229-v1:0',
    });

    // VPC
    const vpc = new ec2.Vpc(this, 'ProxyVpc', {
      cidr: '10.250.0.0/16',
      maxAzs: 2, // Deploy across 2 availability zones
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Internet Gateway (automatically created by VPC)

    // IAM Role for Lambda
    const lambdaRole = new iam.Role(this, 'ProxyApiHandlerServiceRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles'],
        resources: ['*'],
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          'arn:aws:bedrock:*:*:inference-profile/*',
        ],
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [apiKeySecretArn.valueAsString],
      })
    );

    // Lambda Function
    const proxyApiHandler = new lambda.Function(this, 'ProxyApiHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../api')),
      handler: 'index.lambda_handler',
      memorySize: 1024,
      timeout: cdk.Duration.seconds(600),
      environment: {
        DEBUG: 'false',
        API_KEY_SECRET_ARN: apiKeySecretArn.valueAsString,
        DEFAULT_MODEL: defaultModelId.valueAsString,
        DEFAULT_EMBEDDING_MODEL: 'cohere.embed-multilingual-v3',
        ENABLE_CROSS_REGION_INFERENCE: 'true',
      },
      role: lambdaRole,
      architecture: lambda.Architecture.ARM_64,
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ProxyALB', {
      vpc,
      internetFacing: true,
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'ProxyALBSecurityGroup', {
      vpc,
      description: 'Security Group for Proxy ALB',
    });

    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');

    alb.addSecurityGroup(albSecurityGroup);

    const listener = alb.addListener('Listener', {
      port: 80,
      open: true,
    });

    // Target Group for Lambda
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ProxyALBTargetGroup', {
      vpc,
      targets: [new LambdaTarget(proxyApiHandler)],
      targetType: elbv2.TargetType.LAMBDA,
      healthCheck: {
        enabled: false,
      },
    });

    listener.addTargetGroups('ProxyTargetGroup', {
      targetGroups: [targetGroup],
    });

    // Output
    new cdk.CfnOutput(this, 'APIBaseUrl', {
      description: 'Proxy API Base URL (OPENAI_API_BASE)',
      value: `http://${alb.loadBalancerDnsName}/api/v1`,
    });
  }
}