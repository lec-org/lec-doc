jest.mock('nanoid', () => ({
  customAlphabet: jest.fn(() => jest.fn()),
}));
jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));
jest.mock('../../collaboration/collaboration.util', () => ({
  jsonToNode: jest.fn(),
}));

import { ShareController } from './share.controller';

const PAGE_ID = '10000000-0000-4000-8000-000000000001';
const SHARE_ID = '20000000-0000-4000-8000-000000000001';
const SPACE_ID = '30000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '40000000-0000-4000-8000-000000000001';
const USER_ID = '50000000-0000-4000-8000-000000000001';

const pageCandidate = {
  id: PAGE_ID,
  workspaceId: WORKSPACE_ID,
  spaceId: SPACE_ID,
  deletedAt: null,
};
const shareCandidate = { shareId: SHARE_ID, ...pageCandidate };
const user = { id: USER_ID, workspaceId: WORKSPACE_ID } as any;
const workspace = { id: WORKSPACE_ID } as any;

function makeController() {
  const trace: string[] = [];
  const shareService = {
    getShareForPage: jest.fn().mockImplementation(async () => {
      trace.push('sensitive');
      return { id: SHARE_ID };
    }),
    createShare: jest.fn().mockImplementation(async () => {
      trace.push('sensitive');
      return { id: SHARE_ID };
    }),
    isSharingAllowed: jest.fn().mockResolvedValue(true),
    updateShare: jest.fn().mockImplementation(async () => {
      trace.push('sensitive');
      return { id: SHARE_ID };
    }),
  };
  const shareRepo = {
    findAuthorizationSubject: jest.fn().mockImplementation(async () => {
      trace.push('candidate');
      return shareCandidate;
    }),
    findById: jest.fn(),
    deleteShare: jest.fn().mockImplementation(async () => {
      trace.push('sensitive');
    }),
  };
  const pageRepo = {
    findAccessSubject: jest.fn().mockImplementation(async () => {
      trace.push('candidate');
      return pageCandidate;
    }),
    findById: jest.fn(),
  };
  const pagePermissionRepo = {
    hasRestrictedAncestor: jest.fn().mockResolvedValue(false),
  };
  const pageAccessService = {
    validateCanView: jest.fn().mockImplementation(async () => {
      trace.push('authorize');
    }),
    validateCanEdit: jest.fn().mockImplementation(async () => {
      trace.push('authorize');
    }),
  };
  const auditService = { log: jest.fn() };
  const controller = new ShareController(
    shareService as any,
    shareRepo as any,
    pageRepo as any,
    pagePermissionRepo as any,
    pageAccessService as any,
    {} as any,
    auditService as any,
  );
  return {
    controller,
    trace,
    shareService,
    shareRepo,
    pageRepo,
    pagePermissionRepo,
    pageAccessService,
  };
}

describe('ShareController authorization ordering', () => {
  it.each([
    [
      'inspect',
      ({ controller }: ReturnType<typeof makeController>) =>
        controller.getShareForPage({ pageId: PAGE_ID }, user, workspace),
    ],
    [
      'create',
      ({ controller }: ReturnType<typeof makeController>) =>
        controller.create({ pageId: PAGE_ID } as any, user, workspace),
    ],
    [
      'update',
      ({ controller }: ReturnType<typeof makeController>) =>
        controller.update({ shareId: SHARE_ID } as any, user),
    ],
    [
      'delete',
      ({ controller }: ReturnType<typeof makeController>) =>
        controller.delete({ shareId: SHARE_ID }, user),
    ],
  ])(
    'authorizes a minimal subject before sensitive %s reads',
    async (_name, call) => {
      const deps = makeController();

      await call(deps);

      expect(deps.trace).toEqual(['candidate', 'authorize', 'sensitive']);
      expect(deps.pageRepo.findById).not.toHaveBeenCalled();
      expect(deps.shareRepo.findById).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'inspect',
      ({ controller }: ReturnType<typeof makeController>) =>
        controller.getShareForPage({ pageId: PAGE_ID }, user, workspace),
    ],
    [
      'create',
      ({ controller }: ReturnType<typeof makeController>) =>
        controller.create({ pageId: PAGE_ID } as any, user, workspace),
    ],
    [
      'update',
      ({ controller }: ReturnType<typeof makeController>) =>
        controller.update({ shareId: SHARE_ID } as any, user),
    ],
    [
      'delete',
      ({ controller }: ReturnType<typeof makeController>) =>
        controller.delete({ shareId: SHARE_ID }, user),
    ],
  ])(
    'fails closed before sensitive %s reads when Core is unavailable',
    async (_name, call) => {
      const deps = makeController();
      const coreError = new Error('Core unavailable');
      deps.pageAccessService.validateCanView.mockRejectedValue(coreError);
      deps.pageAccessService.validateCanEdit.mockRejectedValue(coreError);

      await expect(call(deps)).rejects.toBe(coreError);

      expect(deps.shareService.getShareForPage).not.toHaveBeenCalled();
      expect(deps.shareService.createShare).not.toHaveBeenCalled();
      expect(deps.shareService.updateShare).not.toHaveBeenCalled();
      expect(deps.shareRepo.deleteShare).not.toHaveBeenCalled();
      expect(
        deps.pagePermissionRepo.hasRestrictedAncestor,
      ).not.toHaveBeenCalled();
      expect(deps.shareService.isSharingAllowed).not.toHaveBeenCalled();
    },
  );
});
