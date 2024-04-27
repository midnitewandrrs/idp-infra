import { Construct } from "constructs";
import { Fn, TerraformOutput, TerraformStack } from "cdktf";
import { AwsProvider, codebuild, datasources, ecr, ecs, elb, iam } from "@cdktf/provider-aws";
import { PetAppStackConfig } from './interfaces'

export default class PetAppStack extends TerraformStack {
  constructor(scope: Construct, name: string, config: PetAppStackConfig) {
    super(scope, name);

    new AwsProvider(this, "agency.dev", {
      region: "us-east-1",
      profile: config.profile,
    });

    const callerIdentity = new datasources.DataAwsCallerIdentity(this, "current")

    const ecrRepository = new ecr.EcrRepository(this, "repository", {
      name: name,
      imageTagMutability: 'MUTABLE', // Must be mutable for us to push new versions to the `latest` tag
      tags: {
        owner: config.owner,
      }
    })

    // This allows CodeBuild to pull Amazon ECR images from this repository
    // https://docs.aws.amazon.com/codebuild/latest/userguide/sample-ecr.html
    new ecr.EcrRepositoryPolicy(this, 'ecrPolicy', {
      repository: ecrRepository.name,
      policy: Fn.jsonencode({
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": [
              "ecr:GetDownloadUrlForLayer",
              "ecr:BatchGetImage",
              "ecr:BatchCheckLayerAvailability"
            ],
            "Principal": {
              "Service": "codebuild.amazonaws.com"
            }
          }
        ]
      })
    })

    const targetGroup = new elb.LbTargetGroup(this, "targetGroup", {
      name: name,
      port: 3456,
      protocol: 'HTTP',
      targetType: 'ip',
      vpcId: config.vpcId,
      tags: {
        owner: config.owner,
      }
    })

    const loadBalancer = new elb.Alb(this, 'loadBalancer', {
      name: name,
      internal: false,
      loadBalancerType: 'application',
      securityGroups: [config.publicSecurityGroup.securityGroupIdOutput],
      subnets: config.publicSubnets,
      enableDeletionProtection: false, // Ensures we can use Terraform to delete it
      tags: {
        owner: config.owner,
      }
    })

    new elb.LbListener(this, 'listener', {
      loadBalancerArn: loadBalancer.arn,
      port: 80,
      protocol: "HTTP",
      defaultAction: [{
        type: "forward",
        targetGroupArn: targetGroup.arn,
      }],
      tags: {
        owner: config.owner,
      }
    })

    const ecsTaskExecutionRoleAssumeRolePolicyDocument = new iam.DataAwsIamPolicyDocument(this, "ecsTaskExecutionRoleAssumeRolePolicyDocument", {
      statement: [
          {
            effect: "Allow",
            principals: [{
              type: "Service",
              identifiers: ["ecs-tasks.amazonaws.com"],
            }],
            actions: ["sts:AssumeRole"]
          }
        ]
    })

    const ecsTaskExecutionRole = new iam.IamRole(this, "ecsTaskExecutionRole", {
      name: `${name}-execution`,
      assumeRolePolicy: ecsTaskExecutionRoleAssumeRolePolicyDocument.json,
    })

    new iam.IamRolePolicyAttachment(this, "ecsTaskExecutionRoleRolePolicyAttachment", {
      role: ecsTaskExecutionRole.name,
      policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    })

    const ecsTaskDefinition = new ecs.EcsTaskDefinition(this, "taskDefinition", {
      family: name,
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      cpu: '256',
      memory: '512',
      executionRoleArn: ecsTaskExecutionRole.arn,
      containerDefinitions: Fn.jsonencode([{
        name: "app",
        image: `${ecrRepository.repositoryUrl}:latest`,
        essential: true,
        environment: [{
          name: 'PORT',
          value: '3456',
        }],
        portMappings: [{
          containerPort: 3456,
        }]
      }]),
      tags: {
        owner: config.owner,
      }
    })

    const ecsService = new ecs.EcsService(this, "service", {
      name: name,
      cluster: config.ecsClusterName,
      launchType: "FARGATE",
      taskDefinition: ecsTaskDefinition.arn,
      desiredCount: 2,
      loadBalancer: [{
        targetGroupArn: targetGroup.arn,
        containerName: "app",
        containerPort: 3456,
      }],
      networkConfiguration: {
        assignPublicIp: false,
        securityGroups: [config.appSecurityGroup.securityGroupIdOutput],
        subnets: config.appSubnets || [],
      },
      tags: {
        owner: config.owner,
      }
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
      name: `${name}-codebuild-service-role`,
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

              // Required to run `aws ecs update-service`
              "ecs:UpdateService"
            ],
            "Resource": [
              "*",
            ]
          }
        ]
      })
    })

    const customCodebuildPolicyAttachment = new iam.IamRolePolicyAttachment(this, "codebuildServiceRoleRolePolicyAttachment", {
      role: codebuildServiceRole.name,
      policyArn: codebuildServiceRolePolicy.arn,
    })

    const ecrCodebuildPolicyAttachment = new iam.IamRolePolicyAttachment(this, "codebuildServiceRoleRolePolicyAttachmentAmazonEC2ContainerRegistryFullAccess", {
      role: codebuildServiceRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryFullAccess",
    })

    // https://docs.aws.amazon.com/codebuild/latest/userguide/auth-and-access-control-iam-identity-based-access-control.html#admin-access-policy
    const adminCodebuildPolicyAttachment = new iam.IamRolePolicyAttachment(this, "codebuildServiceRoleRolePolicyAttachmentAWSCodeBuildAdminAccess", {
      role: codebuildServiceRole.name,
      policyArn: "arn:aws:iam::aws:policy/AWSCodeBuildAdminAccess",
    })

    const project = new codebuild.CodebuildProject(this, "project", {
      dependsOn: [customCodebuildPolicyAttachment, ecrCodebuildPolicyAttachment, adminCodebuildPolicyAttachment],
      name: `${name}-build-pipeline`,
      serviceRole: codebuildServiceRole.arn,
      artifacts: { type: "NO_ARTIFACTS" },
      environment: {
        computeType: 'BUILD_GENERAL1_SMALL', // https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html
        type: 'LINUX_CONTAINER', // https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html
        image: 'aws/codebuild/amazonlinux2-x86_64-standard:3.0', // https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-available.html
        imagePullCredentialsType: "CODEBUILD", // https://docs.aws.amazon.com/codebuild/latest/userguide/create-project-cli.html#cli.environment.imagepullcredentialstype
        privilegedMode: true, // Needed to build Docker images
      },
      source: {
        type: "GITHUB",
        location: `https://github.com/${config.repository}.git`,
        gitCloneDepth: 1, // Only get the latest revision
        gitSubmodulesConfig: {
          fetchSubmodules: true,
        },
        reportBuildStatus: true,
        // Available Environment Variables - https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-env-vars.html
        buildspec: `
version: 0.2
phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin ${callerIdentity.accountId}.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
  build:
    commands:
      - echo Building the Docker image...          
      - docker build -t ${ecrRepository.repositoryUrl}:latest .
  post_build:
    commands:
      - echo Pushing the Docker image...
      - docker push ${ecrRepository.repositoryUrl}:latest
      - aws ecs update-service --cluster ${config.ecsClusterName} --service ${ecsService.name} --force-new-deployment
`
      },
      vpcConfig: {
        vpcId: config.vpcId,
        securityGroupIds: [config.appSecurityGroup.securityGroupIdOutput],
        subnets: config.appSubnets || [],
      },
      tags: {
        owner: config.owner,
      }
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
          pattern: config.branch,
        }]
      }]
    })

    new TerraformOutput(this, "lbDnsName", {
      value: loadBalancer.dnsName,
    });
  }
}

export { default as getBaseConfig } from './getBaseConfig';
