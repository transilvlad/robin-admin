export interface MailDomain {
  domain: string;
  enabled: boolean;
  plus_addressing: boolean;
  catch_all: string | null;
}

export interface SenderGrant {
  account: string;
  address: string;
  grant_type: 'primary' | 'alias' | 'delegated';
}
