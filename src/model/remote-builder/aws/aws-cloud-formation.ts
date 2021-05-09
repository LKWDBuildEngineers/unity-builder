import * as AWS from 'aws-sdk';
import RemoteBuilderEnvironmentVariable from '../remote-builder-environment-variable';
import RemoteBuilderSecret from '../remote-builder-secret';
import RemoteBuilderTaskDef from '../remote-builder-task-def';
import RemoteBuilderUID from '../remote-builder-uid';
import * as fs from 'fs';
import * as core from '@actions/core';

class CloudFormation {
  static async createCloudFormationStack(
    CF: AWS.CloudFormation,
    buildUid: string,
    stackName: string,
    image: string,
    entrypoint: string[],
    commands: string[],
    mountdir: string,
    workingdir: string,
    environment: RemoteBuilderEnvironmentVariable[],
    secrets: RemoteBuilderSecret[],
  ): Promise<RemoteBuilderTaskDef> {
    const logid = RemoteBuilderUID.GetUniqueId(9);
    commands[1] += `
      echo "${logid}"
    `;
    const taskDefStackName = `${stackName}-${buildUid}`;
    let taskDefCloudFormation = this.readTaskCloudFormationTemplate();
    for (const secret of secrets) {
      const insertionStringParameters = 'p1 - input';
      const insertionStringSecrets = 'p2 - secret';
      const insertionStringContainerSecrets = 'Secrets:';
      const indexp1 =
        taskDefCloudFormation.search(insertionStringParameters) + insertionStringParameters.length + '\n'.length;
      const parameterTemplate = `
  ${secret.ParameterKey}:
    Type: String
    Default: ''
`;
      taskDefCloudFormation = [
        taskDefCloudFormation.slice(0, indexp1),
        parameterTemplate,
        taskDefCloudFormation.slice(indexp1),
      ].join('');
      const indexp2 =
        taskDefCloudFormation.search(insertionStringSecrets) + insertionStringSecrets.length + '\n'.length;
      const secretTemplate = `
  ${secret.ParameterKey}Secret:
    Type: AWS::SecretsManager::Secret
    Properties: 
      Name: !Join [ "", [ '${secret.ParameterKey}', !Ref BUILDID ] ]
      SecretString: !Ref ${secret.ParameterKey}
`;
      taskDefCloudFormation = [
        taskDefCloudFormation.slice(0, indexp2),
        secretTemplate,
        taskDefCloudFormation.slice(indexp2),
      ].join('');
      const indexp3 =
        taskDefCloudFormation.search(insertionStringContainerSecrets) +
        insertionStringContainerSecrets.length +
        '\n'.length;
      const containerDefinitionSecretTemplate = `
            - Name: '${secret.EnvironmentVariable ? secret.EnvironmentVariable : secret.ParameterKey}'
              ValueFrom: !Ref ${secret.ParameterKey}Secret
`;
      taskDefCloudFormation = [
        taskDefCloudFormation.slice(0, indexp3),
        containerDefinitionSecretTemplate,
        taskDefCloudFormation.slice(indexp3),
      ].join('');
    }
    for (const environmentVariable of environment) {
      const insertionStringKey = 'p1 - input';
      const index = taskDefCloudFormation.search(insertionStringKey) + insertionStringKey.length + '\n'.length;
      core.info(environmentVariable.name);
      core.info(environmentVariable.value);
      const parameterTemplate = `
  ${environmentVariable.name.replace(/[^\dA-Za-z]/g, '')}:
    Type: String
    Default: ''
`;
      taskDefCloudFormation = [
        taskDefCloudFormation.slice(0, index),
        parameterTemplate,
        taskDefCloudFormation.slice(index),
      ].join('');
      const insertionStringKeyContainerDef = 'Environment:';
      const indexContainerDef =
        taskDefCloudFormation.search(insertionStringKeyContainerDef) +
        insertionStringKeyContainerDef.length +
        '\n'.length;
      const parameterContainerDefTemplate = `
            - Name: '${environmentVariable.name}'
              Value: !Ref ${environmentVariable.name.replace(/[^\dA-Za-z]/g, '')}
`;
      taskDefCloudFormation = [
        taskDefCloudFormation.slice(0, indexContainerDef),
        parameterContainerDefTemplate,
        taskDefCloudFormation.slice(indexContainerDef),
      ].join('');
    }
    core.info('Cloud Formation template for this build step:');
    core.info(taskDefCloudFormation);
    const mappedSecrets = secrets.map((x) => {
      return { ParameterKey: x.ParameterKey.replace(/[^\dA-Za-z]/g, ''), ParameterValue: x.ParameterValue };
    });
    await CF.createStack({
      StackName: taskDefStackName,
      TemplateBody: taskDefCloudFormation,
      Parameters: [
        {
          ParameterKey: 'ImageUrl',
          ParameterValue: image,
        },
        {
          ParameterKey: 'ServiceName',
          ParameterValue: taskDefStackName,
        },
        {
          ParameterKey: 'Command',
          ParameterValue: commands.join(','),
        },
        {
          ParameterKey: 'EntryPoint',
          ParameterValue: entrypoint.join(','),
        },
        {
          ParameterKey: 'WorkingDirectory',
          ParameterValue: workingdir,
        },
        {
          ParameterKey: 'EFSMountDirectory',
          ParameterValue: mountdir,
        },
        {
          ParameterKey: 'BUILDID',
          ParameterValue: buildUid,
        },
        ...mappedSecrets,
      ],
    }).promise();
    core.info('Creating worker cluster...');

    const cleanupTaskDefStackName = `${taskDefStackName}-cleanup`;
    const cleanupCloudFormation = fs.readFileSync(`${__dirname}/cloud-formations/cloudformation-stack-ttl.yml`, 'utf8');
    await CF.createStack({
      StackName: cleanupTaskDefStackName,
      TemplateBody: cleanupCloudFormation,
      Capabilities: ['CAPABILITY_IAM'],
      Parameters: [
        {
          ParameterKey: 'StackName',
          ParameterValue: taskDefStackName,
        },
        {
          ParameterKey: 'DeleteStackName',
          ParameterValue: cleanupTaskDefStackName,
        },
        {
          ParameterKey: 'TTL',
          ParameterValue: '100',
        },
        {
          ParameterKey: 'BUILDID',
          ParameterValue: buildUid,
        },
      ],
    }).promise();
    core.info('Creating cleanup cluster...');

    try {
      await CF.waitFor('stackCreateComplete', { StackName: taskDefStackName }).promise();
    } catch (error) {
      core.error(error);
    }

    const taskDefResources = (
      await CF.describeStackResources({
        StackName: taskDefStackName,
      }).promise()
    ).StackResources;

    const baseResources = (await CF.describeStackResources({ StackName: stackName }).promise()).StackResources;

    // in the future we should offer a parameter to choose if you want the guarnteed shutdown.
    core.info('Worker cluster created successfully (skipping wait for cleanup cluster to be ready)');

    const cluster = baseResources?.find((x) => x.LogicalResourceId === 'ECSCluster')?.PhysicalResourceId || '';
    const taskDefinition =
      taskDefResources?.find((x) => x.LogicalResourceId === 'TaskDefinition')?.PhysicalResourceId || '';
    const SubnetOne = baseResources?.find((x) => x.LogicalResourceId === 'PublicSubnetOne')?.PhysicalResourceId || '';
    const SubnetTwo = baseResources?.find((x) => x.LogicalResourceId === 'PublicSubnetTwo')?.PhysicalResourceId || '';
    const ContainerSecurityGroup =
      baseResources?.find((x) => x.LogicalResourceId === 'ContainerSecurityGroup')?.PhysicalResourceId || '';
    const streamName = taskDefResources?.find((x) => x.LogicalResourceId === 'KinesisStream')?.PhysicalResourceId || '';

    return {
      taskDefStackName,
      taskDefCloudFormation,
      taskDefStackNameTTL: cleanupTaskDefStackName,
      ttlCloudFormation: cleanupCloudFormation,
      logid,
      ECSCluster: cluster,
      TaskDefinition: taskDefinition,
      SubnetOne,
      SubnetTwo,
      ContainerSecurityGroup,
      KinesisStream: streamName,
    };
  }

  static readTaskCloudFormationTemplate(): string {
    return fs.readFileSync(`${__dirname}/cloud-formations/task-def-formation.yml`, 'utf8');
  }

  static async cleanupResources(CF: AWS.CloudFormation, taskDef: RemoteBuilderTaskDef) {
    await CF.deleteStack({
      StackName: taskDef.taskDefStackName,
    }).promise();

    await CF.deleteStack({
      StackName: taskDef.taskDefStackNameTTL,
    }).promise();

    await CF.waitFor('stackDeleteComplete', {
      StackName: taskDef.taskDefStackName,
    }).promise();

    // Currently too slow and causes too much waiting
    await CF.waitFor('stackDeleteComplete', {
      StackName: taskDef.taskDefStackNameTTL,
    }).promise();

    core.info('Cleanup complete');
  }
}
export default CloudFormation;
