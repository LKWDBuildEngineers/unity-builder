import AWS from 'aws-sdk';
import RemoteBuilderTaskDef from '../remote-builder-task-def';
import * as core from '@actions/core';
import * as zlib from 'zlib';

class KinesisLogStream {
  static async streamLogsUntilTaskStops(
    ECS: AWS.ECS,
    CF: AWS.CloudFormation,
    taskDef: RemoteBuilderTaskDef,
    clusterName: string,
    taskArn: string,
    kinesisStreamName: string,
  ) {
    // watching logs
    const kinesis = new AWS.Kinesis();

    const getTaskData = async () => {
      const tasks = await ECS.describeTasks({
        cluster: clusterName,
        tasks: [taskArn],
      }).promise();
      return tasks.tasks?.[0];
    };

    const stream = await kinesis
      .describeStream({
        StreamName: kinesisStreamName,
      })
      .promise();

    let iterator =
      (
        await kinesis
          .getShardIterator({
            ShardIteratorType: 'TRIM_HORIZON',
            StreamName: stream.StreamDescription.StreamName,
            ShardId: stream.StreamDescription.Shards[0].ShardId,
          })
          .promise()
      ).ShardIterator || '';

    await CF.waitFor('stackCreateComplete', { StackName: taskDef.taskDefStackNameTTL }).promise();

    core.info(`Task status is ${(await getTaskData())?.lastStatus}`);

    const logBaseUrl = `https://${AWS.config.region}.console.aws.amazon.com/cloudwatch/home?region=${AWS.config.region}#logsV2:log-groups/log-group/${taskDef.taskDefStackName}`;
    core.info(`You can also see the logs at AWS Cloud Watch: ${logBaseUrl}`);

    let readingLogs = true;
    let timestamp: number = 0;
    while (readingLogs) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const taskData = await getTaskData();
      if (taskData?.lastStatus !== 'RUNNING') {
        if (timestamp === 0) {
          core.info('Task stopped, streaming end of logs');
          timestamp = Date.now();
        }
        if (timestamp !== 0 && Date.now() - timestamp < 30000) {
          core.info('Task status is not RUNNING for 30 seconds, last query for logs');
          readingLogs = false;
        }
      }
      const records = await kinesis
        .getRecords({
          ShardIterator: iterator,
        })
        .promise();
      iterator = records.NextShardIterator || '';
      if (records.Records.length > 0 && iterator) {
        for (let index = 0; index < records.Records.length; index++) {
          const json = JSON.parse(
            zlib.gunzipSync(Buffer.from(records.Records[index].Data as string, 'base64')).toString('utf8'),
          );
          if (json.messageType === 'DATA_MESSAGE') {
            for (let logEventsIndex = 0; logEventsIndex < json.logEvents.length; logEventsIndex++) {
              if (json.logEvents[logEventsIndex].message.includes(taskDef.logid)) {
                core.info('End of task logs');
                readingLogs = false;
              } else {
                core.info(json.logEvents[logEventsIndex].message);
              }
            }
          }
        }
      }
    }
  }
}
export default KinesisLogStream;
