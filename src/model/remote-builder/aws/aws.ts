import * as SDK from 'aws-sdk';
import RemoteBuilderSecret from '../remote-builder-secret';
import RemoteBuilderEnvironmentVariable from '../remote-builder-environment-variable';
import * as core from '@actions/core';
import RemoteBuilderTaskDef from '../remote-builder-task-def';
import CloudFormation from './aws-cloud-formation';
import KinesisLogStream from './aws-kinesis-log-stream';

class AWS {
  static async run(
    buildId: string,
    stackName: string,
    image: string,
    commands: string[],
    mountdir: string,
    workingdir: string,
    environment: RemoteBuilderEnvironmentVariable[],
    secrets: RemoteBuilderSecret[],
  ) {
    const ECS = new SDK.ECS();
    const CF = new SDK.CloudFormation();
    const entrypoint = ['/bin/sh'];

    const taskDef = await CloudFormation.createCloudFormationStack(
      CF,
      buildId,
      stackName,
      image,
      entrypoint,
      commands,
      mountdir,
      workingdir,
      environment,
      secrets,
    );

    await this.runTask(taskDef, ECS, CF, environment, buildId);

    await CloudFormation.cleanupResources(CF, taskDef);
  }

  static async runTask(
    taskDef: RemoteBuilderTaskDef,
    ECS: AWS.ECS,
    CF: AWS.CloudFormation,
    environment: RemoteBuilderEnvironmentVariable[],
    buildUid: string,
  ) {
    const cluster = taskDef.ECSCluster;
    const taskDefinition = taskDef.TaskDefinition;
    const SubnetOne = taskDef.SubnetOne;
    const SubnetTwo = taskDef.SubnetTwo;
    const ContainerSecurityGroup = taskDef.ContainerSecurityGroup;
    const streamName = taskDef.KinesisStream;
    const task = await ECS.runTask({
      cluster,
      taskDefinition,
      platformVersion: '1.4.0',
      overrides: {
        containerOverrides: [
          {
            name: taskDef.taskDefStackName,
            environment: [...environment, { name: 'BUILDID', value: buildUid }],
          },
        ],
      },
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [SubnetOne, SubnetTwo],
          assignPublicIp: 'ENABLED',
          securityGroups: [ContainerSecurityGroup],
        },
      },
    }).promise();

    core.info('Task is starting on worker cluster');
    const taskArn = task.tasks?.[0].taskArn || '';

    try {
      await ECS.waitFor('tasksRunning', { tasks: [taskArn], cluster }).promise();
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const describeTasks = await ECS.describeTasks({
        tasks: [taskArn],
        cluster,
      }).promise();
      core.info(`Task has ended ${describeTasks.tasks?.[0].containers?.[0].lastStatus}`);
      core.setFailed(error);
      core.error(error);
    }
    core.info(`Task is running on worker cluster`);
    await KinesisLogStream.streamLogsUntilTaskStops(ECS, CF, taskDef, cluster, taskArn, streamName);
    await ECS.waitFor('tasksStopped', { cluster, tasks: [taskArn] }).promise();
    const exitCode = (
      await ECS.describeTasks({
        tasks: [taskArn],
        cluster,
      }).promise()
    ).tasks?.[0].containers?.[0].exitCode;
    if (exitCode !== 0) {
      try {
        await CloudFormation.cleanupResources(CF, taskDef);
      } catch (error) {
        core.warning(`failed to cleanup ${error}`);
      }
      core.error(`job failed with exit code ${exitCode}`);
      throw new Error(`job failed with exit code ${exitCode}`);
    } else {
      core.info(`Task has finished successfully`);
    }
  }
}
export default AWS;
