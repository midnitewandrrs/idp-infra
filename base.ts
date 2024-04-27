import { Construct } from "constructs";
import { Fn, TerraformStack } from "cdktf";
import { AwsProvider, codebuild, dynamodb, ec2, ecs, iam, ssm } from "@cdktf/provider-aws";
import { Vpc } from './.gen/modules/vpc';
import { SecurityGroup } from './.gen/modules/security-group';

interface BaseStackConfig {
  cidr: string;
  profile: string;
}

export default class BaseStack extends TerraformStack {
  public readonly vpc: Vpc;
  public readonly publicSecurityGroup: SecurityGroup;
  public readonly appSecurityGroup: SecurityGroup;
  public readonly dataSecurityGroup: SecurityGroup;
  public readonly ecsCluster: ecs.EcsCluster;
  public readonly dynamoDBTable: dynamodb.DynamodbTable;
  constructor(scope: Construct, name: string, config: BaseStackConfig) {
    super(scope, name);

    new AwsProvider(this, "agency.dev", {
      region: "us-east-1",
      profile: config.profile,
    });

    const vpc = new Vpc(this, `${name}-ue1-main`, {
      name: `${name}-ue1-main`,
      cidr: config.cidr,
      azs: ['us-east-1a', 'us-east-1b', 'us-east-1c'],
      // https://www.terraform.io/language/functions/cidrsubnet
      publicSubnets: [0, 1, 2].map((netnum: number) => Fn.cidrsubnet(config.cidr, 8, netnum)),
      privateSubnets: [4, 5, 6].map((netnum: number) => Fn.cidrsubnet(config.cidr, 8, netnum)),
      databaseSubnets: [8, 9, 10].map((netnum: number) => Fn.cidrsubnet(config.cidr, 8, netnum)),
      enableNatGateway: true,
      oneNatGatewayPerAz: true,
      enableDnsHostnames: true,
    })

    const securityGroups: { [key: string]: SecurityGroup } = {};

    securityGroups.public = new SecurityGroup(this, "public", {
      name: "public",
      vpcId: vpc.vpcIdOutput,
      ingressWithSelf: [{ rule: "all-all" }],
      egressWithSelf: [{ rule: "all-all" }],
      egressCidrBlocks: ["0.0.0.0/0"],
      egressRules: ["all-all"],
      ingressCidrBlocks: ["0.0.0.0/0"],
      ingressRules: ["http-80-tcp", "https-443-tcp"],
    })

    securityGroups.app = new SecurityGroup(this, "app", {
      name: "app",
      vpcId: vpc.vpcIdOutput,
      ingressWithSelf: [{ rule: "all-all" }],
      egressWithSelf: [{ rule: "all-all" }],
      egressCidrBlocks: ["0.0.0.0/0"],
      egressRules: ["all-all"],
      computedIngressWithSourceSecurityGroupId: [{
        "rule": "all-all",
        "source_security_group_id": securityGroups.public.securityGroupIdOutput,
      }],
      numberOfComputedIngressWithSourceSecurityGroupId: 1,
    })

    securityGroups.data = new SecurityGroup(this, "data", {
      name: "data",
      vpcId: vpc.vpcIdOutput,
      ingressWithSelf: [{ rule: "all-all" }],
      egressWithSelf: [{ rule: "all-all" }],
      egressCidrBlocks: ["0.0.0.0/0"],
      egressRules: ["all-all"],
      computedIngressWithSourceSecurityGroupId: [{
        "rule": "all-all",
        "source_security_group_id": securityGroups.app.securityGroupIdOutput,
      }],
      numberOfComputedIngressWithSourceSecurityGroupId: 1,
    })

    new iam.IamServiceLinkedRole(this, "ecs", {
      awsServiceName: "ecs.amazonaws.com",
    })

    const ecsCluster = new ecs.EcsCluster(this, "ecs-cluster-main", {
      name: "main",
    })

    new ecs.EcsClusterCapacityProviders(this, "ecs-capacity-provider-main", {
      clusterName: ecsCluster.name,
      capacityProviders: ["FARGATE"]
    })

    const dynamoDBTable = new dynamodb.DynamodbTable(this, `${name}-idp-environment`, {
      name: `${name}-idp-environment`,
      billingMode: 'PROVISIONED',
      readCapacity: 2,
      writeCapacity: 2,
      hashKey: "environment",
      attribute: [{
        name: "environment",
        type: "S", // S = string, N = number, B = binary
      }],
    })

    // @ts-ignore
    const environmentTypesTable = new dynamodb.DynamodbTable(this, `${name}-idp-environment-type`, {
      name: `${name}-idp-environment-type`,
      billingMode: 'PROVISIONED',
      readCapacity: 2,
      writeCapacity: 2,
      hashKey: "envType",
      attribute: [{
        name: "envType",
        type: "S", // S = string, N = number, B = binary
      }],
    })

    const codebuildServiceRoleAssumeRolePolicyDocument = new iam.DataAwsIamPolicyDocument(this, "codebuildServiceRoleAssumeRolePolicyDocument", {
      statement: [
        {
          effect: "Allow",
          principals: [{
            type: "Service",
            identifiers: ["codebuild.amazonaws.com"],
          }],
          actions: ["sts:AssumeRole"]
        }
      ]
    })

    const codebuildServiceRole = new iam.IamRole(this, "codebuildServiceRole", {
      name: `codebuild-service-role-infra-environment-types-dynamodb-sync`,
      assumeRolePolicy: codebuildServiceRoleAssumeRolePolicyDocument.json,
    })

    const codebuildServiceRolePolicy = new iam.IamPolicy(this, "codebuildServiceRolePolicy", {
      policy: Fn.jsonencode({
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": [
              "cloudwatch:*",
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
              "s3:PutObject",
              "s3:GetObject",
              "s3:GetObjectVersion",
              "s3:GetBucketAcl",
              "s3:GetBucketLocation",

              // Allow CodeBuild access to AWS services required to create a VPC network interface
              "ec2:CreateNetworkInterface",
              "ec2:DescribeDhcpOptions",
              "ec2:DescribeNetworkInterfaces",
              "ec2:DeleteNetworkInterface",
              "ec2:DescribeSubnets",
              "ec2:DescribeSecurityGroups",
              "ec2:DescribeVpcs",
              "ec2:CreateNetworkInterfacePermission",
            ],
            "Resource": [
              "*",
            ]
          }
        ]
      })
    })

    new iam.IamRolePolicyAttachment(this, "codebuildServiceRoleRolePolicyAttachment", {
      role: codebuildServiceRole.name,
      policyArn: codebuildServiceRolePolicy.arn,
    })

    new iam.IamRolePolicyAttachment(this, "codebuildServiceRoleRolePolicyAttachmentAWSCodeBuildAdminAccess", {
      role: codebuildServiceRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess",
    })

    const project = new codebuild.CodebuildProject(this, "project", {
      dependsOn: [environmentTypesTable],
      name: `infra-environment-types-dynamodb-sync`,
      serviceRole: codebuildServiceRole.arn,
      artifacts: { type: "NO_ARTIFACTS" },
      environment: {
        computeType: 'BUILD_GENERAL1_SMALL', // https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html
        type: 'LINUX_CONTAINER', // https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html
        image: 'aws/codebuild/standard:5.0', // https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-available.html
        imagePullCredentialsType: "CODEBUILD", // https://docs.aws.amazon.com/codebuild/latest/userguide/create-project-cli.html#cli.environment.imagepullcredentialstype
        privilegedMode: false,
      },
      source: {
        type: "GITHUB",
        location: `TODO: INFRA_GITHUB_URL`,
        gitCloneDepth: 1, // Only get the latest revision
        gitSubmodulesConfig: {
          fetchSubmodules: true,
        },
        reportBuildStatus: true,
        // Available Environment Variables - https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-env-vars.html
        buildspec: `
version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 14
  pre_build:
    commands:
      - echo Installing dependencies
      - npm install
  build:
    commands:
      - echo Running synchronization script    
      - DYNAMODB_TABLE_NAME=${environmentTypesTable.name} npx ts-node ./scripts/syncEnvType.ts
`
      },
      vpcConfig: {
        vpcId: vpc.vpcIdOutput,
        securityGroupIds: [securityGroups.app.securityGroupIdOutput],
        subnets: Fn.tolist(vpc.privateSubnetsOutput) || [],
      },
    })

    new codebuild.CodebuildWebhook(this, "webhook", {
      projectName: project.name,
      buildType: "BUILD",
      // https://docs.aws.amazon.com/codebuild/latest/userguide/github-webhook.html
      filterGroup: [{
        filter: [{
          type: "EVENT",
          pattern: "PUSH",
        }, {
          type: "HEAD_REF",
          pattern: "main",
        }]
      }]
    })

    const amiId = new ssm.DataAwsSsmParameter(this, 'latest-amazon-linux-2-ami-id', {
      name: '/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2'
    })

    // There's an undocumented 'bug' where you can't launch more than 2 ECS tasks unless you've launched an EC2 instance
    // If you try, you'll see the error "You've reached the limit on the number of tasks you can run concurrently"
    // This instance is created to avoid this error
    // It should qualify for the free tier
    new ec2.Instance(this, 'activation', {
      ami: amiId.value,
      instanceType: 't2.micro', // If `t2.micro` is not available in your region, choose `t3.micro` to keep using the Free Tier,
      associatePublicIpAddress: false,
      subnetId: Fn.element(Fn.tolist(vpc.privateSubnetsOutput), 0),
    })

    this.vpc = vpc;
    this.publicSecurityGroup = securityGroups.public;
    this.appSecurityGroup = securityGroups.app;
    this.dataSecurityGroup = securityGroups.data;
    this.ecsCluster = ecsCluster;
    this.dynamoDBTable = dynamoDBTable;
  }
}
