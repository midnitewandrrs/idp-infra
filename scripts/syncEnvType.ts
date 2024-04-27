import * as fs from 'fs/promises';
import * as path from 'path';
import { DynamoDBClient, ScanCommand, DeleteItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";

const dynamodbTablename = process.env.DYNAMODB_TABLE_NAME;
const awsRegion = process.env.AWS_REGION || "us-east-1";
if (dynamodbTablename === undefined) {
  throw new Error('DynamoDB table not defined. Aborting.')
}

const client = new DynamoDBClient({
  region: awsRegion,
});

const contribPath = path.resolve(__dirname, '../contrib');

function standardizeSchema(rawSchema: string): string {
  try {
    const parsedSchema = JSON.parse(rawSchema)
    return JSON.stringify(parsedSchema);
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.error(e.message);
    }
    return ''; // Prevents one bad schema from syncing the rest
  }
}

async function getEnvironmentTypeNames() {
  const files = await fs.readdir(contribPath, {
    withFileTypes: true, // Returns fs.Dirent instance rather than strings or Buffers
  })
  return files
    .filter(file => file.isDirectory)
    .map(file => file.name)
}

async function getEnvironmentTypesData() {
  const names = await getEnvironmentTypeNames()
  const data = [];
  for (const name of names) {
    const schemaPath = path.resolve(contribPath, name, 'schema.json');
    const rawSchema = (await fs.readFile(schemaPath)).toString()
    const schema = standardizeSchema(rawSchema);
    data.push({ envType: name, schema })
  }
  return data;
}

async function purgeDB(dynamodbTablename: string) {
  const scanParams = {
    TableName: dynamodbTablename,
  }
  const command = new ScanCommand(scanParams);
  const scanOutput = await client.send(command);
  if (scanOutput.Items) {
    return Promise.allSettled(scanOutput.Items.map(item => {
      const deleteParams = {
        Key: {
          "envType": {
            S: item.envType.S || '',
          },
        },
        TableName: dynamodbTablename,
        ConditionExpression: "attribute_exists(envType)", // Only delete if it exists
      }
      const command = new DeleteItemCommand(deleteParams);
      return client.send(command)
    }))
  }
  return Promise.resolve();
}

async function syncEnvironmentTypes() {
  const environmentTypesData = await getEnvironmentTypesData()
  const purgeResults = await purgeDB(dynamodbTablename!);
  environmentTypesData.forEach(async (environmentTypeData) => {
    try {
      const params = {
        Item: {
          "envType": {
            S: environmentTypeData.envType,
          },
          "schema": {
            S: environmentTypeData.schema,
          },
        },
        TableName: dynamodbTablename,
      }
      const command = new PutItemCommand(params); // https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_PutItem.html
      await client.send(command);
    } catch (e) {
      console.error(`Failed to sync ${environmentTypeData.envType}: ${(e as any).message}`)
    }
  })
}

syncEnvironmentTypes();
