import { App } from "cdktf";
import BaseStack from "./base"
import PetAppStack, { getBaseConfig } from "./contrib/PetApp"

const app = new App();
const devBase = new BaseStack(app, "dev-base", {
  cidr: '10.1.0.0/16',
  profile: "AWS_PROFILE", // TODO: Specify AWS named profile
});
new PetAppStack(app, "petapp-test", {
  ...getBaseConfig(devBase),
  owner: "admin",
  branch: "GITHUB_REPOSITORY_BRANCH", // TODO: Specify GitHub branch to build
})

app.synth();
