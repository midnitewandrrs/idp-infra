import { SecurityGroup } from '../../.gen/modules/security-group';
import { BaseConfig } from '../../interfaces';

interface PetAppStackConfig extends BaseConfig, PetAppStackBaseConfig, PetAppStackCustomConfig {}

interface PetAppStackBaseConfig {
  profile: string;
  repository: string;
  vpcId: string;
  appSecurityGroup: SecurityGroup,
  publicSecurityGroup: SecurityGroup,
  publicSubnets: string[] | undefined,
  appSubnets: string[] | undefined,
  ecsClusterName: string;
}

interface PetAppStackCustomConfig {
  branch: string;
}

export {
    PetAppStackConfig,
    PetAppStackBaseConfig,
    PetAppStackCustomConfig,
}