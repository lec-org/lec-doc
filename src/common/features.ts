export const Feature = {
  SECURITY_SETTINGS: 'security:settings',
  SCIM: 'scim',
  PERSONAL_SPACES: 'spaces:personal',
  VIEWER_COMMENTS: 'comment:viewer',
  AI_CONTROLS: 'ai:controls',
  MCP_CONTROLS: 'mcp:controls',
  PUBLIC_SPACE_APPEARANCE: 'public-space:appearance',
} as const;

export type FeatureKey = (typeof Feature)[keyof typeof Feature];
