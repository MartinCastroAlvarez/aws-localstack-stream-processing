import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

// Environment configuration
const env = {
  // Environment name (defaults to 'local')
  environment: (process.env.ENVIRONMENT || 'local').charAt(0).toUpperCase() + (process.env.ENVIRONMENT || 'local').slice(1),
  
  // AWS account ID (defaults to LocalStack's dummy account)
  account: process.env.CDK_DEFAULT_ACCOUNT || '000000000000',
  
  // AWS region (defaults to us-east-1)
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  
  // Database password for Aurora PostgreSQL
  // In production, this should be stored in AWS Secrets Manager
  dbPassword: process.env.DB_PASSWORD || 'admin123',
  
  // Firehose buffer size in MB
  // Determines how much data Firehose will buffer before writing to S3
  // Default: 128MB (max: 128MB)
  firehoseBufferSize: parseInt(process.env.FIREHOSE_BUFFER_SIZE || '128'),
  
  // Firehose buffer interval in seconds
  // How long Firehose will wait before writing to S3
  // Default: 60 seconds (min: 60s, max: 900s)
  firehoseBufferInterval: parseInt(process.env.FIREHOSE_BUFFER_INTERVAL || '60'),

  // Lambda SQS batch size
  // Number of messages to process in a single Lambda invocation
  // Default: 10 (max: 10,000)
  lambdaBatchSize: parseInt(process.env.LAMBDA_BATCH_SIZE || '10'),

  // Lambda reserved concurrency
  // Maximum number of concurrent Lambda executions
  // Default: 5
  lambdaReservedConcurrency: parseInt(process.env.LAMBDA_RESERVED_CONCURRENCY || '5'),

  // Lambda memory size in MB
  // Amount of memory allocated to the Lambda function
  // Default: 256MB (min: 128MB, max: 10,240MB)
  lambdaMemorySize: parseInt(process.env.LAMBDA_MEMORY_SIZE || '256'),

  // Lambda SQS batch window in seconds
  // Maximum time to wait for messages to accumulate before invoking Lambda
  // Default: 30 seconds (max: 300s)
  lambdaBatchWindow: parseInt(process.env.LAMBDA_BATCH_WINDOW || '30'),

  // Number of partitions for Firehose data
  // Determines how many parallel partitions data will be written to
  // Default: 5 partitions
  partition: parseInt(process.env.PARTITION || '5'),
};

class StreamProcessingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a VPC with public and private subnets
    // This provides network isolation and security for our resources
    // - Public subnets: For resources that need internet access
    // - Private subnets: For resources that should be isolated from the internet
    const vpc = new ec2.Vpc(this, `${env.environment}VPC`, {
      maxAzs: 2, // Use 2 Availability Zones for high availability
      natGateways: 1, // Single NAT Gateway for cost optimization
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }
      ],
    });

    // Create S3 bucket for the data lake
    // This bucket stores raw data files from Firehose
    // - Server-side encryption enabled for data at rest
    // - SSL enforcement for data in transit
    // - Automatic cleanup on stack deletion
    // - Same-region access enforcement for Firehose
    const lake = new s3.Bucket(this, `${env.environment}DataLakeBucket`, {
      bucketName: `${env.environment.toLowerCase()}-data-lake`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    // Add bucket policy to enforce same-region access
    // This ensures Firehose can only write to the bucket in the same region
    lake.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      principals: [new iam.ServicePrincipal('firehose.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [lake.arnForObjects('*')],
      conditions: {
        StringNotEquals: {
          'aws:SourceVpce': [vpc.vpcId],
          'aws:RequestedRegion': [env.region]
        }
      }
    }));

    // Create DynamoDB table for signatures
    // This table stores digital signatures for processed records
    // - Composite key (PK, SK) for flexible data modeling
    // - Pay-per-request billing for cost optimization
    // - Point-in-time recovery for data protection
    const table = new dynamodb.Table(this, `${env.environment}SignaturesTable`, {
      tableName: `${env.environment.toLowerCase()}-signatures`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    // Create SQS queue for stream processing
    // This queue receives notifications when new files arrive in S3
    // - Dead Letter Queue for failed message handling
    // - 14-day message retention
    // - Visibility timeout matches Lambda timeout
    const queue = new sqs.Queue(this, `${env.environment}StreamProcessingDLQ`, {
      queueName: `${env.environment.toLowerCase()}-stream-processing-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const streamProcessingQueue = new sqs.Queue(this, `${env.environment}StreamProcessingQueue`, {
      queueName: `${env.environment.toLowerCase()}-stream-processing-queue`,
      visibilityTimeout: cdk.Duration.seconds(900), // Match Lambda timeout
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: queue,
        maxReceiveCount: 3, // Messages will be moved to DLQ after 3 failed attempts
      },
    });

    // Add resource policy to allow S3 to send notifications to SQS
    // This enables S3 event notifications to trigger the processing pipeline
    streamProcessingQueue.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [streamProcessingQueue.queueArn],
      conditions: {
        ArnLike: { 'aws:SourceArn': lake.bucketArn },
      },
    }));

    // Create VPC Endpoints for AWS Services
    // These endpoints allow secure access to AWS services from within the VPC
    // - S3 Gateway Endpoint: For S3 access
    // - SQS Interface Endpoint: For message queue access
    // - DynamoDB Gateway Endpoint: For database access
    // - Secrets Manager Interface Endpoint: For secret access without data transfer costs

    // S3 Gateway Endpoint
    vpc.addGatewayEndpoint(`${env.environment}S3Endpoint`, {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // SQS Interface Endpoint in private subnet
    vpc.addInterfaceEndpoint(`${env.environment}SqsEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.SQS,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [new ec2.SecurityGroup(this, `${env.environment}SqsEndpointSG`, {
        vpc,
        description: 'Security group for SQS VPC endpoint',
        allowAllOutbound: true,
      })],
    });

    // DynamoDB Gateway Endpoint
    vpc.addGatewayEndpoint(`${env.environment}DynamoDBEndpoint`, {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Secrets Manager Interface Endpoint in private subnet
    // This endpoint allows secure access to Secrets Manager without data transfer costs
    const secretsManagerEndpoint = vpc.addInterfaceEndpoint(`${env.environment}SecretsManagerEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [new ec2.SecurityGroup(this, `${env.environment}SecretsManagerEndpointSG`, {
        vpc,
        description: 'Security group for Secrets Manager VPC endpoint',
        allowAllOutbound: true,
      })],
    });

    // Create security group for Aurora
    // This controls network access to the database
    const dbsg = new ec2.SecurityGroup(this, `${env.environment}DBSecurityGroup`, {
      vpc,
      description: 'Security group for Aurora DB',
      allowAllOutbound: true,
    });

    // Allow inbound PostgreSQL access
    dbsg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access'
    );

    // Create Aurora Serverless v2 cluster
    // This provides a serverless PostgreSQL database
    // - Automatic scaling based on demand
    // - High availability with writer and reader instances
    // - Data API enabled for HTTP-based access
    const db = new rds.DatabaseCluster(this, `${env.environment}AuroraCluster`, {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_3,
      }),
      instanceProps: {
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T4G,
          ec2.InstanceSize.MEDIUM
        ),
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroups: [dbsg],
      },
      credentials: rds.Credentials.fromGeneratedSecret('admin', {
        secretName: `${env.environment.toLowerCase()}-aurora-credentials`,
      }),
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      readers: [
        rds.ClusterInstance.serverlessV2('Reader1'),
      ],
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 1,
      enableDataApi: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Add policy to Secrets Manager endpoint to restrict access
    // This ensures only resources within our VPC can access secrets
    secretsManagerEndpoint.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.AnyPrincipal()],
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret'
      ],
      resources: [
        db.secret?.secretArn || '*',  // Aurora secret
        `arn:aws:secretsmanager:${env.region}:${env.account}:secret:*`  // Any other secrets
      ],
      conditions: {
        StringEquals: {
          'aws:SourceVpc': vpc.vpcId
        }
      }
    }));

    // Create IAM role for the signer Lambda
    // This role defines what AWS services the Lambda can access
    const signerRole = new iam.Role(this, `${env.environment}SignerRole`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // Grant Lambda basic execution permissions
    // This allows the Lambda to write logs to CloudWatch
    signerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Grant Lambda permissions to read from data lake
    lake.grantRead(signerRole);

    // Grant Lambda permissions to read the Aurora secret
    db.secret?.grantRead(signerRole);

    // Grant Lambda permissions to read and decrypt secrets
    signerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
        'kms:Decrypt'
      ],
      resources: [
        db.secret?.secretArn || '*',  // Aurora secret
        `arn:aws:secretsmanager:${env.region}:${env.account}:secret:*`  // Any other secrets
      ]
    }));

    // Grant Lambda permissions to write to DynamoDB in batches
    table.grantWriteData(signerRole);

    // Create the signer Lambda function
    // This function processes records from S3 and stores signatures in DynamoDB
    // - Configurable memory and timeout
    // - Reserved concurrency for cost control
    // - Environment variables for resource access
    const signer = new lambda.Function(this, `${env.environment}SignerFunction`, {
      functionName: `${env.environment.toLowerCase()}-signer`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('signer'),
      role: signerRole,
      timeout: cdk.Duration.seconds(900), // Maximum Lambda timeout
      memorySize: env.lambdaMemorySize,
      reservedConcurrentExecutions: env.lambdaReservedConcurrency,
      environment: {
        // S3 bucket containing the raw data files
        DATA_LAKE_BUCKET: lake.bucketName,
        
        // Aurora cluster connection details
        AURORA_CLUSTER_ENDPOINT: db.clusterEndpoint.hostname,
        AURORA_CLUSTER_PORT: db.clusterEndpoint.port.toString(),
        
        // ARN of the secret containing Aurora credentials
        AURORA_SECRET_ARN: db.secret?.secretArn || '',
        
        // DynamoDB table for storing signatures
        SIGNATURES_TABLE: table.tableName,

        // Maximum number of retries for address locking
        MAX_RETRIES: '3',
      },
    });

    // Add SQS event source to Lambda
    // This triggers the Lambda when messages arrive in the queue
    // - Configurable batch size and window
    // - Automatic scaling based on queue depth
    signer.addEventSource(new lambdaEventSources.SqsEventSource(streamProcessingQueue, {
      batchSize: env.lambdaBatchSize,
      maxBatchingWindow: cdk.Duration.seconds(env.lambdaBatchWindow),
      enabled: true,
    }));

    // Create IAM role for Firehose
    // This role allows Firehose to write to S3
    const firehoseRole = new iam.Role(this, `${env.environment}FirehoseRole`, {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });

    // Grant Firehose all necessary permissions to S3
    lake.grantReadWrite(firehoseRole);

    // Create IAM role for the partitioner Lambda
    // This role allows the Lambda to process Firehose records
    const partitionerRole = new iam.Role(this, `${env.environment}PartitionerRole`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // Grant Lambda basic execution permissions
    partitionerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Create the partitioner Lambda function
    // This function determines which partition each record should go to
    // - Uses a hash function to distribute records evenly
    // - Returns partition metadata for Firehose
    const partitioner = new lambda.Function(this, `${env.environment}PartitionerFunction`, {
      functionName: `${env.environment.toLowerCase()}-partitioner`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('partitioner'),
      role: partitionerRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 128,
      environment: {
        PARTITION: env.partition.toString(),
      },
    });

    // Create Firehose delivery stream with dynamic partitioning
    // This stream writes data to S3 in the data lake
    // - Configurable buffer size and interval
    // - Error handling with separate error prefix
    // - Dynamic partitioning based on Lambda function
    const inputPath = 'year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/';
    const firehoseStream = new firehose.CfnDeliveryStream(this, `${env.environment}FirehoseStream`, {
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: lake.bucketArn,
        roleArn: firehoseRole.roleArn,
        bufferingHints: {
          intervalInSeconds: env.firehoseBufferInterval,
          sizeInMBs: env.firehoseBufferSize,
        },
        compressionFormat: 'UNCOMPRESSED', // Keep raw format for data lake
        prefix: `raw/!{partitionKeyFromLambda:bucketPartition}/${inputPath}`,
        errorOutputPrefix: `errors/${inputPath}/!{firehose:error-output-type}`,
        dynamicPartitioningConfiguration: {
          enabled: true
        },
        processingConfiguration: {
          enabled: true,
          processors: [{
            type: 'Lambda',
            parameters: [{
              parameterName: 'LambdaArn',
              parameterValue: partitioner.functionArn
            }]
          }]
        }
      },
    });

    // Grant Firehose permission to invoke the partitioner Lambda
    partitioner.grantInvoke(firehoseRole);

    // Add S3 event notification for raw prefix
    // This triggers the processing pipeline when new files arrive
    lake.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(streamProcessingQueue),
      { prefix: 'raw/' } as s3.NotificationKeyFilter
    );

    // Create SNS topic for alarms
    const alarmTopic = new sns.Topic(this, `${env.environment}AlarmTopic`, {
      topicName: `${env.environment.toLowerCase()}-alarms`,
      displayName: `${env.environment} Stream Processing Alarms`,
    });

    // Create CloudWatch dashboard
    const dashboard = new cloudwatch.Dashboard(this, `${env.environment}Dashboard`, {
      dashboardName: `${env.environment.toLowerCase()}-stream-processing`,
    });

    // Lambda metrics
    const lambdaErrors = signer.metricErrors({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const lambdaInvocations = signer.metricInvocations({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const lambdaDuration = signer.metricDuration({
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const lambdaThrottles = signer.metricThrottles({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    // SQS metrics
    const queueDepth = streamProcessingQueue.metricApproximateNumberOfMessagesVisible({
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const queueAge = streamProcessingQueue.metricApproximateAgeOfOldestMessage({
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const queueErrors = streamProcessingQueue.metricNumberOfMessagesReceived({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    // DynamoDB metrics
    const dynamoConsumedWriteCapacity = table.metricConsumedWriteCapacityUnits({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const dynamoConsumedReadCapacity = table.metricConsumedReadCapacityUnits({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const dynamoThrottledRequests = table.metricThrottledRequests({
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    // Add widgets to dashboard
    dashboard.addWidgets(
      // Lambda metrics
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors and Throttles',
        left: [lambdaErrors],
        right: [lambdaThrottles],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations and Duration',
        left: [lambdaInvocations],
        right: [lambdaDuration],
        width: 12,
      }),
      // SQS metrics
      new cloudwatch.GraphWidget({
        title: 'SQS Queue Depth and Age',
        left: [queueDepth],
        right: [queueAge],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'SQS Messages Received',
        left: [queueErrors],
        width: 12,
      }),
      // DynamoDB metrics
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Consumed Capacity',
        left: [dynamoConsumedWriteCapacity],
        right: [dynamoConsumedReadCapacity],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Throttled Requests',
        left: [dynamoThrottledRequests],
        width: 12,
      })
    );

    // Create alarms
    // Lambda error rate alarm
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, `${env.environment}LambdaErrorAlarm`, {
      metric: lambdaErrors,
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Lambda function is experiencing errors',
      alarmName: `${env.environment.toLowerCase()}-lambda-errors`,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Queue depth alarm
    const queueDepthAlarm = new cloudwatch.Alarm(this, `${env.environment}QueueDepthAlarm`, {
      metric: queueDepth,
      threshold: 1000, // Adjust based on your needs
      evaluationPeriods: 3,
      alarmDescription: 'SQS queue is growing too large',
      alarmName: `${env.environment.toLowerCase()}-queue-depth`,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Queue age alarm
    const queueAgeAlarm = new cloudwatch.Alarm(this, `${env.environment}QueueAgeAlarm`, {
      metric: queueAge,
      threshold: 300, // 5 minutes in seconds
      evaluationPeriods: 3,
      alarmDescription: 'Messages are staying in the queue too long',
      alarmName: `${env.environment.toLowerCase()}-queue-age`,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // DynamoDB throttling alarm
    const dynamoThrottlingAlarm = new cloudwatch.Alarm(this, `${env.environment}DynamoThrottlingAlarm`, {
      metric: dynamoThrottledRequests,
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'DynamoDB is experiencing throttling',
      alarmName: `${env.environment.toLowerCase()}-dynamo-throttling`,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add alarm actions
    const alarmAction = new cloudwatch_actions.SnsAction(alarmTopic);
    lambdaErrorAlarm.addAlarmAction(alarmAction);
    queueDepthAlarm.addAlarmAction(alarmAction);
    queueAgeAlarm.addAlarmAction(alarmAction);
    dynamoThrottlingAlarm.addAlarmAction(alarmAction);

    // Add OK actions to clear alarms
    lambdaErrorAlarm.addOkAction(alarmAction);
    queueDepthAlarm.addOkAction(alarmAction);
    queueAgeAlarm.addOkAction(alarmAction);
    dynamoThrottlingAlarm.addOkAction(alarmAction);

    // Output important values for reference
    // These values can be used by other stacks or for debugging
    new cdk.CfnOutput(this, `${env.environment}DataLakeBucketName`, {
      value: lake.bucketName,
      description: 'Name of the S3 bucket storing raw data',
      exportName: `${env.environment}DataLakeBucketName`,
    });

    new cdk.CfnOutput(this, `${env.environment}SignaturesTableName`, {
      value: table.tableName,
      description: 'Name of the DynamoDB table storing signatures',
      exportName: `${env.environment}SignaturesTableName`,
    });

    new cdk.CfnOutput(this, `${env.environment}FirehoseStreamName`, {
      value: firehoseStream.ref,
      description: 'Name of the Firehose delivery stream',
      exportName: `${env.environment}FirehoseStreamName`,
    });

    new cdk.CfnOutput(this, `${env.environment}DatabaseEndpoint`, {
      value: db.clusterEndpoint.hostname,
      description: 'Aurora cluster endpoint',
      exportName: `${env.environment}DatabaseEndpoint`,
    });

    new cdk.CfnOutput(this, `${env.environment}DatabasePort`, {
      value: db.clusterEndpoint.port.toString(),
      description: 'Aurora cluster port',
      exportName: `${env.environment}DatabasePort`,
    });

    new cdk.CfnOutput(this, `${env.environment}DatabaseSecretArn`, {
      value: db.secret?.secretArn || 'No secret created',
      description: 'Aurora cluster secret ARN',
      exportName: `${env.environment}DatabaseSecretArn`,
    });

    new cdk.CfnOutput(this, `${env.environment}SignerFunctionName`, {
      value: signer.functionName,
      description: 'Name of the signer Lambda function',
      exportName: `${env.environment}SignerFunctionName`,
    });

    new cdk.CfnOutput(this, `${env.environment}StreamProcessingQueueUrl`, {
      value: streamProcessingQueue.queueUrl,
      description: 'URL of the stream processing queue',
      exportName: `${env.environment}StreamProcessingQueueUrl`,
    });

    new cdk.CfnOutput(this, `${env.environment}StreamProcessingQueueArn`, {
      value: streamProcessingQueue.queueArn,
      description: 'ARN of the stream processing queue',
      exportName: `${env.environment}StreamProcessingQueueArn`,
    });

    // Add dashboard URL to outputs
    new cdk.CfnOutput(this, `${env.environment}DashboardUrl`, {
      value: `https://${env.region}.console.aws.amazon.com/cloudwatch/home?region=${env.region}#dashboards:name=${env.environment.toLowerCase()}-stream-processing`,
      description: 'CloudWatch Dashboard URL',
      exportName: `${env.environment}DashboardUrl`,
    });

    new cdk.CfnOutput(this, `${env.environment}AlarmTopicArn`, {
      value: alarmTopic.topicArn,
      description: 'SNS Topic ARN for alarms',
      exportName: `${env.environment}AlarmTopicArn`,
    });
  }
}

const app = new cdk.App();
new StreamProcessingStack(app, `${env.environment}StreamProcessingStack`, 
    {
        env: {
            account: env.account,
            region: env.region,
        },
    }
);
app.synth(); 