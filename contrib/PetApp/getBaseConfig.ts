import { Fn } from "cdktf";
import BaseStack from "../../base";
import { PetAppStackBaseConfig } from "./interfaces";

export default function(devBase: BaseStack): PetAppStackBaseConfig {
    return ({
        repository: "GITHUB_REPOSITORY_NAME", // TODO: Specify GitHub repository for PetApp
        profile: "AWS_PROFILE", // TODO: Specify AWS named profile
        vpcId: devBase.vpc.vpcIdOutput,
        publicSecurityGroup: devBase.publicSecurityGroup,
        appSecurityGroup: devBase.appSecurityGroup,
        publicSubnets: Fn.tolist(devBase.vpc.publicSubnetsOutput),
        appSubnets: Fn.tolist(devBase.vpc.privateSubnetsOutput),
        ecsClusterName: devBase.ecsCluster.name,
    })
}
