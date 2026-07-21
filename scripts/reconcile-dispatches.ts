import "dotenv/config"; import { disconnectPrisma } from "@facereel/db"; import { dispatchPending } from "@facereel/dispatch";
dispatchPending(Number(process.argv[2]||50)).then(result=>{console.log(JSON.stringify(result));if(result.failed)process.exitCode=1}).finally(disconnectPrisma);
