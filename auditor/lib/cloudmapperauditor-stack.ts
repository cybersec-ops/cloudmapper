import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscription from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const yaml = require('js-yaml');
const fs   = require('fs');

export class CloudMapperAuditorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Load config file
    var config = yaml.load(fs.readFileSync('./s3_bucket_files/cdk_app.yaml', 'utf8'));

    if (config['s3_bucket'] == 'MYCOMPANY-cloudmapper') {
      console.log("You must configure the CDK app by editing ./s3_bucket_files/cdk_app.yaml");
      process.exit(1);
    }

    // Create VPC to run everything in. We make this public just because we don't
    // want to spend $30/mo on a NAT gateway.
    const vpc = new ec2.Vpc(this, 'CloudMapperVpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC
        }
      ]
    });

    // Define the ECS task
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'taskDefinition', {
      // Uncomment if you need to change resource limits of Fargate task definition and container
      // memoryLimitMiB: 512,
      // cpu: 256
    });

    taskDefinition.addContainer('cloudmapper-container', {
      image: ecs.ContainerImage.fromAsset('./resources'),
      memoryLimitMiB: 512,
      cpu: 256,
      environment: {
        S3_BUCKET: config['s3_bucket'],
        MINIMUM_ALERT_SEVERITY: config['minimum_alert_severity'],
        MINIMUM_REPORT_SEVERITY: config['minimum_report_severity']
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: 'cloudmapper',
        logRetention: logs.RetentionDays.TWO_WEEKS
      })
    });

    // Grant the ability to assume the IAM role in any account
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      resources: ["arn:aws:iam::*:role/"+config['iam_role']],
      actions: ['sts:AssumeRole']
    }));

    // Grant the ability to read and write the files from the S3 bucket
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      resources: ["arn:aws:s3:::"+config['s3_bucket']],
      actions: ['s3:ListBucket']
    }));
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      resources: ["arn:aws:s3:::"+config['s3_bucket']+"/*"],
      actions: ['s3:GetObject','s3:PutObject', 's3:DeleteObject']
    }));

    // Grant the ability to record the stdout to CloudWatch Logs
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      resources: ["*"],
      actions: ['logs:*']
    }));

    // Grant the ability to record error and success metrics
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      // This IAM privilege has no paths or conditions
      resources: ["*"],
      actions: ['cloudwatch:PutMetricData']
    }));

    // Grant the ability to read from Secrets Manager
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      // This IAM privilege has no paths or conditions
      resources: ["*"],
      actions: ['secretsmanager:GetSecretValue'],
      conditions: { 'ForAnyValue:StringLike': { 'secretsmanager:SecretId': '*cloudmapper-slack-webhook*' } }
    }));

    // Create rule to trigger this be run every 24 hours
    new events.Rule(this, 'scheduled_run', {
      ruleName: "cloudmapper_scheduler",
      // Run at 2am EST (6am UTC) every night
      schedule: events.Schedule.expression("cron(0 6 * * ? *)"),
      description: "Starts the CloudMapper auditing task every night",
      targets: [new targets.EcsTask({
        cluster: cluster,
        taskDefinition: taskDefinition,
        subnetSelection: { subnetType: ec2.SubnetType.PUBLIC }
      })]
    });

    // Create rule to trigger this manually
    new events.Rule(this, 'manual_run', {
      ruleName: "cloudmapper_manual_run",
      eventPattern: { source: ['cloudmapper'] },
      description: "Allows CloudMapper auditing to be manually started",
      targets: [new targets.EcsTask({
        cluster: cluster,
        taskDefinition: taskDefinition,
        subnetSelection: { subnetType: ec2.SubnetType.PUBLIC }
      })]
    });

    // Create alarm for any errors
    const error_alarm =  new cloudwatch.Alarm(this, 'error_alarm', {
      alarmName: "cloudmapper_errors",
      alarmDescription: "Detect errors",
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      metric: new cloudwatch.Metric({
        namespace: 'cloudmapper',
        metricName: "errors",
        statistic: cloudwatch.Stats.SUM
      })
    });

    // Create SNS for alarms to be sent to
    const sns_topic = new sns.Topic(this, 'cloudmapper_alarm', {
      displayName: 'cloudmapper_alarm'
    });

    // Connect the alarm to the SNS
    error_alarm.addAlarmAction(new cloudwatch_actions.SnsAction(sns_topic));

    // Create Lambda to forward alarms
    const alarm_forwarder = new lambda.Function(this, "alarm_forwarder", {
      runtime: lambda.Runtime.PYTHON_3_10,
      code: lambda.Code.fromAsset("resources/alarm_forwarder"),
      handler: "main.handler",
      description: "Forwards alarms from the local SNS to another",
      logRetention: logs.RetentionDays.TWO_WEEKS,
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        "ALARM_SNS": config['alarm_sns_arn']
      }
    });

    // Add priv to publish the events so the alarms can be forwarded
    alarm_forwarder.addToRolePolicy(new iam.PolicyStatement({
      resources: [config['alarm_sns_arn']],
      actions: ['sns:Publish']
    }));

    // Connect the SNS to the Lambda
    sns_topic.addSubscription(new sns_subscription.LambdaSubscription(alarm_forwarder));
  }
}

module.exports = { CloudMapperAuditorStack }