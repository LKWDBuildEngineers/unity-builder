class RemoteBuilderTaskDef {
  public taskDefStackName!: string;
  public taskDefCloudFormation!: string;
  public taskDefStackNameTTL!: string;
  public ttlCloudFormation!: string;
  public logid!: string;
  public ECSCluster!: string;
  public TaskDefinition!: string;
  public SubnetOne!: string;
  public SubnetTwo!: string;
  public ContainerSecurityGroup!: string;
  public KinesisStream!: string;
}
export default RemoteBuilderTaskDef;
