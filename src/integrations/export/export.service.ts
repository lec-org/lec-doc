import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { jsonToHtml, jsonToNode } from '../../collaboration/collaboration.util';
import { ExportFormat } from './dto/export-dto';
import { Page, User } from '@docmost/db/types/entity.types';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import * as JSZip from 'jszip';
import { StorageService } from '../storage/storage.service';
import {
  buildTree,
  computeLocalPath,
  getExportExtension,
  getPageTitle,
  getSafePageTitle,
  PageExportTree,
  replaceInternalLinks,
  updateAttachmentUrlsToLocalPaths,
} from './utils';
import {
  ExportMetadata,
  ExportPageMetadata,
} from '../../common/helpers/types/export-metadata.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { Node } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import slugify from '@sindresorhus/slugify';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('../../../package.json');
import { EnvironmentService } from '../environment/environment.service';
import { DomainService } from '../environment/domain.service';
import {
  getAttachmentIds,
  getProsemirrorContent,
} from '../../common/helpers/prosemirror/utils';
import { htmlToMarkdown } from '@lec/doc-editor';
import { LecAuthorizationService } from '../../core/lec-authorization/lec-authorization.service';
import { collectReferencesFromPmJson } from '../../core/page/transclusion/utils/transclusion-prosemirror.util';

type AllowedAttachment = {
  id: string;
  fileName: string;
  filePath: string;
  pageId: string | null;
  workspaceId: string;
};

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storageService: StorageService,
    private readonly environmentService: EnvironmentService,
    private readonly domainService: DomainService,
    private readonly lecAuthorization: LecAuthorizationService,
  ) {}

  async exportPage(
    format: string,
    page: Page,
    singlePage?: boolean,
    user?: User,
    ignorePermissions = false,
  ) {
    if (!ignorePermissions) {
      if (!user) this.lecAuthorization.deny();
      await this.lecAuthorization.requirePage(page, user, 'VIEW');
    }
    const titleNode = {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: getPageTitle(page.title) }],
    };

    let prosemirrorJson: any;

    if (singlePage) {
      const baseUrl = await this.getWorkspaceBaseUrl(page.workspaceId);
      const pageContent = await this.authorizeTransclusionSources(
        getProsemirrorContent(page.content),
        page.workspaceId,
        user,
        ignorePermissions,
      );
      prosemirrorJson = await this.turnPageMentionsToLinks(
        pageContent,
        page.workspaceId,
        baseUrl,
        user,
        ignorePermissions,
      );
    } else {
      // mentions is already turned to links during the zip process
      prosemirrorJson = getProsemirrorContent(page.content);
    }

    if (page.title) {
      prosemirrorJson.content.unshift(titleNode);
    }

    const pageHtml = jsonToHtml(prosemirrorJson);

    if (format === ExportFormat.HTML) {
      return `<!DOCTYPE html>
      <html>
        <head>
         <title>${getPageTitle(page.title)}</title>
        </head>
        <body>${pageHtml}</body>
      </html>`;
    }

    if (format === ExportFormat.Markdown) {
      const newPageHtml = pageHtml.replace(
        /<colgroup[^>]*>[\s\S]*?<\/colgroup>/gim,
        '',
      );
      return htmlToMarkdown(newPageHtml);
    }

    return;
  }

  async exportPages(
    pageId: string,
    format: string,
    includeAttachments: boolean,
    includeChildren: boolean,
    user?: User,
    ignorePermissions = false,
  ) {
    let candidates = includeChildren
      ? await this.pageRepo.findPageTreeCandidates(pageId)
      : [await this.pageRepo.findAuthorizationSubject(pageId)].filter(Boolean);

    if (candidates.length === 0) {
      throw new BadRequestException('No pages to export');
    }

    if (!ignorePermissions) {
      if (!user) this.lecAuthorization.deny();
      candidates = await this.lecAuthorization.filterPages(candidates, user);
      candidates = await this.filterPagesForExport(
        candidates as Page[],
        pageId,
        user.id,
        candidates[0]?.spaceId,
      );
      if (candidates.length === 0) {
        throw new BadRequestException('No accessible pages to export');
      }
    }

    if (!ignorePermissions) {
      candidates = await this.lecAuthorization.filterPages(candidates, user);
      if (candidates.length === 0) {
        throw new BadRequestException('No accessible pages to export');
      }
    }
    const content = await this.pageRepo.findExportPagesByIds(
      candidates.map((page) => page.id),
    );
    const contentById = new Map(content.map((page) => [page.id, page]));
    const pages = candidates
      .map((page) => contentById.get(page.id))
      .filter(Boolean) as Page[];
    const parentPageIndex = pages.findIndex((obj) => obj.id === pageId);

    //After filtering by permissions, if the root page itself is not accessible to the user, findIndex returns -1
    if (parentPageIndex === -1) {
      throw new BadRequestException('Root page is not accessible');
    }
    // set to null to make export of pages with parentId work
    pages[parentPageIndex].parentPageId = null;

    const isSinglePage = pages.length === 1 && !includeAttachments;

    if (isSinglePage) {
      const pageContent = await this.exportPage(
        format,
        pages[0],
        true,
        user,
        ignorePermissions,
      );
      return { type: 'file' as const, content: pageContent, page: pages[0] };
    }

    const tree = buildTree(pages as Page[]);

    const baseUrl = await this.getWorkspaceBaseUrl(pages[0].workspaceId);
    const zip = new JSZip();
    await this.zipPages(
      tree,
      format,
      zip,
      includeAttachments,
      baseUrl,
      user,
      ignorePermissions,
    );

    const zipFile = zip.generateNodeStream({
      type: 'nodebuffer',
      streamFiles: true,
      compression: 'DEFLATE',
    });

    return { type: 'zip' as const, stream: zipFile, page: pages[0] };
  }

  async exportSpace(
    spaceId: string,
    format: string,
    includeAttachments: boolean,
    user?: User,
    ignorePermissions = false,
  ) {
    const space = await this.db
      .selectFrom('spaces')
      .select(['id', 'name'])
      .where('id', '=', spaceId)
      .executeTakeFirst();

    if (!space) {
      throw new NotFoundException('Space not found');
    }

    let candidates = await this.pageRepo.findSpacePageCandidates(spaceId);

    if (!ignorePermissions) {
      if (!user) this.lecAuthorization.deny();
      candidates = await this.lecAuthorization.filterPages(candidates, user);
      candidates = await this.filterPagesForExport(
        candidates as Page[],
        null,
        user.id,
        spaceId,
      );
      if (candidates.length === 0) {
        throw new BadRequestException('No accessible pages to export');
      }
    }

    if (!ignorePermissions) {
      candidates = await this.lecAuthorization.filterPages(candidates, user);
      if (candidates.length === 0) {
        throw new BadRequestException('No accessible pages to export');
      }
    }
    const pages = (await this.pageRepo.findExportPagesByIds(
      candidates.map((page) => page.id),
    )) as Page[];
    if (pages.length === 0) {
      throw new BadRequestException('No accessible pages to export');
    }
    const tree = buildTree(pages);

    const baseUrl = await this.getWorkspaceBaseUrl(pages[0].workspaceId);
    const zip = new JSZip();

    await this.zipPages(
      tree,
      format,
      zip,
      includeAttachments,
      baseUrl,
      user,
      ignorePermissions,
    );

    const zipFile = zip.generateNodeStream({
      type: 'nodebuffer',
      streamFiles: true,
      compression: 'DEFLATE',
    });

    const fileName = `${space.name}-space-export.zip`;
    return {
      fileStream: zipFile,
      fileName,
      spaceName: space.name,
    };
  }

  async zipPages(
    tree: PageExportTree,
    format: string,
    zip: JSZip,
    includeAttachments: boolean,
    baseUrl: string,
    user?: User,
    ignorePermissions = false,
  ): Promise<void> {
    const slugIdToPath: Record<string, string> = {};
    const pageIdToFilePath: Record<string, string> = {};
    const pagesMetadata: Record<string, ExportPageMetadata> = {};

    computeLocalPath(tree, format, null, '', slugIdToPath);

    // Batch resolve attachments once for the whole export so we only run the
    // owning-page view check a single time, regardless of page count.
    const allowedAttachments = includeAttachments
      ? await this.resolveAccessibleAttachments(tree, user, ignorePermissions)
      : new Map<string, AllowedAttachment>();

    const stack: { folder: JSZip; parentPageId: string | null }[] = [
      { folder: zip, parentPageId: null },
    ];

    while (stack.length > 0) {
      const { folder, parentPageId } = stack.pop();
      const children = tree[parentPageId] || [];

      for (const page of children) {
        const childPages = tree[page.id] || [];

        if (!ignorePermissions) {
          if (!user) this.lecAuthorization.deny();
          await this.lecAuthorization.requirePage(page, user, 'VIEW');
        }
        const pageContent = await this.authorizeTransclusionSources(
          getProsemirrorContent(page.content),
          page.workspaceId,
          user,
          ignorePermissions,
        );
        const prosemirrorJson = await this.turnPageMentionsToLinks(
          pageContent,
          page.workspaceId,
          baseUrl,
          user,
          ignorePermissions,
        );

        const currentPagePath = slugIdToPath[page.slugId];

        let updatedJsonContent = replaceInternalLinks(
          prosemirrorJson,
          slugIdToPath,
          currentPagePath,
          baseUrl,
        );

        if (includeAttachments) {
          await this.zipAttachments(
            updatedJsonContent,
            folder,
            allowedAttachments,
            user,
            ignorePermissions,
          );
          updatedJsonContent =
            updateAttachmentUrlsToLocalPaths(updatedJsonContent);
        }

        const pageTitle = getSafePageTitle(page.title);
        const pageExportContent = await this.exportPage(
          format,
          { ...page, content: updatedJsonContent },
          false,
          user,
          true,
        );
        if (!ignorePermissions) {
          await this.lecAuthorization.requirePage(page, user, 'VIEW');
        }

        folder.file(
          `${pageTitle}${getExportExtension(format)}`,
          pageExportContent,
        );

        pageIdToFilePath[page.id] = currentPagePath;

        const parentPath = parentPageId ? pageIdToFilePath[parentPageId] : null;
        pagesMetadata[currentPagePath] = {
          pageId: page.id,
          slugId: page.slugId,
          icon: page.icon ?? null,
          position: page.position,
          parentPath,
          createdAt: page.createdAt?.toISOString() ?? new Date().toISOString(),
          updatedAt: page.updatedAt?.toISOString() ?? new Date().toISOString(),
        };

        if (childPages.length > 0) {
          const pageFolder = folder.folder(pageTitle);
          stack.push({ folder: pageFolder, parentPageId: page.id });
        }
      }
    }

    const metadata: ExportMetadata = {
      exportedAt: new Date().toISOString(),
      source: 'docmost',
      version: packageJson.version,
      pages: pagesMetadata,
    };

    if (!ignorePermissions) {
      if (!user) this.lecAuthorization.deny();
      const exportedPages = Object.values(tree).flat();
      await Promise.all(
        exportedPages.map((page) =>
          this.lecAuthorization.requirePage(page, user, 'VIEW'),
        ),
      );
    }
    zip.file('docmost-metadata.json', JSON.stringify(metadata, null, 2));
  }

  async zipAttachments(
    prosemirrorJson: any,
    zip: JSZip,
    allowed: Map<string, AllowedAttachment>,
    user?: User,
    ignorePermissions = false,
  ) {
    const attachmentIds = getAttachmentIds(prosemirrorJson);

    await Promise.all(
      attachmentIds.map(async (id) => {
        const attachment = allowed.get(id);
        if (!attachment) return;
        if (!ignorePermissions) {
          if (!attachment.pageId) return;
          if (!user) this.lecAuthorization.deny();
          await this.lecAuthorization.requirePage(
            {
              id: attachment.pageId,
              workspaceId: attachment.workspaceId,
              deletedAt: null,
            },
            user,
            'VIEW',
          );
        }
        try {
          const fileBuffer = await this.storageService.read(
            attachment.filePath,
          );
          const filePath = `/files/${attachment.id}/${attachment.fileName}`;
          zip.file(filePath, fileBuffer);
        } catch (err) {
          this.logger.debug(`Attachment export error ${attachment.id}`, err);
        }
      }),
    );
  }

  private async resolveAccessibleAttachments(
    tree: PageExportTree,
    user: User | undefined,
    ignorePermissions: boolean,
  ): Promise<Map<string, AllowedAttachment>> {
    const allAttachmentIds = new Set<string>();
    let spaceId: string | undefined;
    for (const siblings of Object.values(tree)) {
      for (const page of siblings) {
        if (!spaceId) spaceId = page.spaceId;
        if (!ignorePermissions) {
          if (!user) this.lecAuthorization.deny();
          await this.lecAuthorization.requirePage(page, user, 'VIEW');
        }
        for (const id of getAttachmentIds(
          getProsemirrorContent(page.content),
        )) {
          allAttachmentIds.add(id);
        }
      }
    }

    if (allAttachmentIds.size === 0 || !spaceId) {
      return new Map();
    }

    const attachments = await this.db
      .selectFrom('attachments')
      .select(['id', 'fileName', 'filePath', 'pageId', 'workspaceId'])
      .where('id', 'in', [...allAttachmentIds])
      .where('spaceId', '=', spaceId)
      .execute();

    let visible = attachments;
    if (!ignorePermissions) {
      if (!user) this.lecAuthorization.deny();
      const ownerPageIds = [
        ...new Set(
          attachments.map((a) => a.pageId).filter((id): id is string => !!id),
        ),
      ];
      const subjects =
        await this.pageRepo.findAuthorizationSubjectsByIds(ownerPageIds);
      const coreAllowed = await this.lecAuthorization.filterPages(
        subjects,
        user,
      );
      const accessible = coreAllowed.length
        ? await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: coreAllowed.map((page) => page.id),
            userId: user.id,
            spaceId,
          })
        : [];
      const accessibleSet = new Set(accessible);
      visible = attachments.filter(
        (a) => a.pageId && accessibleSet.has(a.pageId),
      );
    }

    return new Map(visible.map((a) => [a.id, a]));
  }

  private async authorizeTransclusionSources(
    prosemirrorJson: any,
    workspaceId: string,
    user: User | undefined,
    ignorePermissions: boolean,
  ) {
    if (ignorePermissions) return prosemirrorJson;
    if (!user) this.lecAuthorization.deny();

    const references = collectReferencesFromPmJson(prosemirrorJson);
    if (references.length === 0) return prosemirrorJson;

    const sourceIds = [...new Set(references.map((ref) => ref.sourcePageId))];
    const subjects =
      await this.pageRepo.findAuthorizationSubjectsByIds(sourceIds);
    const subjectsById = new Map(subjects.map((page) => [page.id, page]));
    const orderedSubjects = sourceIds
      .map((id) => subjectsById.get(id))
      .filter(Boolean);
    const coreAllowed = await this.lecAuthorization.filterPages(
      orderedSubjects,
      user,
      'VIEW',
    );
    const localAllowed = coreAllowed.length
      ? await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: coreAllowed.map((page) => page.id),
          userId: user.id,
        })
      : [];
    const allowed = new Set(localAllowed);

    const redact = (node: any): any => {
      if (!node || typeof node !== 'object') return node;
      if (node.type === 'transclusionReference') {
        return allowed.has(node.attrs?.sourcePageId)
          ? node
          : { type: 'paragraph' };
      }
      if (!Array.isArray(node.content)) return node;
      return { ...node, content: node.content.map(redact) };
    };

    return redact(prosemirrorJson);
  }

  async turnPageMentionsToLinks(
    prosemirrorJson: any,
    workspaceId: string,
    baseUrl: string,
    user?: User,
    ignorePermissions = false,
  ) {
    const doc = jsonToNode(prosemirrorJson);

    let pageMentionIds: string[] = [];

    doc.descendants((node: Node) => {
      if (node.type.name === 'mention' && node.attrs.entityType === 'page') {
        if (node.attrs.entityId) {
          pageMentionIds.push(node.attrs.entityId);
        }
      }
    });

    if (pageMentionIds.length < 1) {
      return prosemirrorJson;
    }

    // Filter to only accessible pages if permissions are enforced
    if (!ignorePermissions) {
      if (!user) this.lecAuthorization.deny();
      const subjects =
        await this.pageRepo.findAuthorizationSubjectsByIds(pageMentionIds);
      const coreAllowed = await this.lecAuthorization.filterPages(
        subjects,
        user,
      );
      pageMentionIds = await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: coreAllowed.map((page) => page.id),
        userId: user.id,
      });
    }

    const pages =
      pageMentionIds.length > 0
        ? await this.db
            .selectFrom('pages')
            .select([
              'id',
              'slugId',
              'title',
              'creatorId',
              'spaceId',
              'workspaceId',
            ])
            .select((eb) => this.pageRepo.withSpace(eb))
            .where('id', 'in', pageMentionIds)
            .where('workspaceId', '=', workspaceId)
            .execute()
        : [];

    const pageMap = new Map(pages.map((page) => [page.id, page]));

    let editorState = EditorState.create({
      doc: doc,
    });

    const transaction = editorState.tr;

    let offset = 0;

    /**
     * Helper function to replace a mention node with a link node.
     */
    const replaceMentionWithLink = (
      node: Node,
      pos: number,
      title: string,
      slugId: string,
      spaceSlug: string,
    ) => {
      const linkTitle = title || 'untitled';
      const truncatedTitle = linkTitle?.substring(0, 70);
      const pageSlug = `${slugify(truncatedTitle)}-${slugId}`;

      const link = `${baseUrl}/s/${spaceSlug}/p/${pageSlug}`;

      // Create a link mark and a text node with that mark
      const linkMark = editorState.schema.marks.link.create({ href: link });
      const linkTextNode = editorState.schema.text(linkTitle, [linkMark]);

      // Calculate positions (adjusted by the current offset)
      const from = pos + offset;
      const to = pos + offset + node.nodeSize;

      // Replace the node in the transaction and update the offset
      transaction.replaceWith(from, to, linkTextNode);
      offset += linkTextNode.nodeSize - node.nodeSize;
    };

    // find and convert page mentions to links
    editorState.doc.descendants((node: Node, pos: number) => {
      // Check if the node is a page mention
      if (node.type.name === 'mention' && node.attrs.entityType === 'page') {
        const { entityId: pageId, slugId, label } = node.attrs;
        const page = pageMap.get(pageId);

        if (page) {
          replaceMentionWithLink(
            node,
            pos,
            page.title,
            page.slugId,
            page.space.slug,
          );
        } else {
          // if page is not found, default to  the node label and slugId
          replaceMentionWithLink(node, pos, label, slugId, 'undefined');
        }
      }
    });

    if (transaction.docChanged) {
      editorState = editorState.apply(transaction);
    }

    const updatedDoc = editorState.doc;

    return updatedDoc.toJSON();
  }

  private async getWorkspaceBaseUrl(workspaceId: string): Promise<string> {
    const workspace = await this.db
      .selectFrom('workspaces')
      .select('hostname')
      .where('id', '=', workspaceId)
      .executeTakeFirst();

    return this.domainService.getUrl(workspace?.hostname);
  }

  private async filterPagesForExport(
    pages: Page[],
    rootPageId: string | null,
    userId: string,
    spaceId: string,
  ): Promise<Page[]> {
    if (pages.length === 0) return [];

    const pageIds = pages.map((p) => p.id);
    const accessibleIds = await this.pagePermissionRepo.filterAccessiblePageIds(
      {
        pageIds,
        userId,
        spaceId,
      },
    );
    const accessibleSet = new Set(accessibleIds);

    const includedIds = new Set<string>();

    let changed = true;
    while (changed) {
      changed = false;
      for (const page of pages) {
        if (includedIds.has(page.id)) continue;
        if (!accessibleSet.has(page.id)) continue;

        // Root page or top-level page in space export
        if (
          page.id === rootPageId ||
          (rootPageId === null && page.parentPageId === null)
        ) {
          includedIds.add(page.id);
          changed = true;
          continue;
        }

        // Non-root: include if parent is already included
        if (page.parentPageId && includedIds.has(page.parentPageId)) {
          includedIds.add(page.id);
          changed = true;
        }
      }
    }

    return pages.filter((p) => includedIds.has(p.id));
  }
}
