import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { markdownToHtml } from '@lec/doc-editor';
import { htmlToJson, jsonToHtml, jsonToMarkdown, jsonToNode, jsonToText, tiptapExtensions } from '../collaboration.util';

const fixture = JSON.parse(readFileSync(require.resolve('@lec/doc-editor/fixtures/community-document.json'), 'utf8'));

describe('Web/Service 共用 Community 格式契约', () => {
  it('HTML 与静态 JSON 在实际服务端 schema 中等价', () => {
    const expected = jsonToNode(fixture.json).toJSON();
    expect(jsonToNode(htmlToJson(fixture.html)).toJSON()).toEqual(expected);
    expect(jsonToNode(htmlToJson(jsonToHtml(fixture.json))).toJSON()).toEqual(expected);
  });

  it('Markdown 导入导出保留中文、标记和文本顺序', async () => {
    const json = htmlToJson(await markdownToHtml(fixture.markdown));
    const text = jsonToText(json);
    for (const part of fixture.texts) expect(text).toContain(part);
    expect(jsonToMarkdown(json)).toContain('**加粗**');
    expect(jsonToMarkdown(json)).toContain('## 乐程协作文档');
  });

  it('静态 Ydoc 及服务端重新编码均与 JSON 等价', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(fixture.ydoc, 'base64'));
    const expected = jsonToNode(fixture.json).toJSON();
    expect(jsonToNode(TiptapTransformer.fromYdoc(doc, 'default')).toJSON()).toEqual(expected);
    const encoded = TiptapTransformer.toYdoc(fixture.json, 'default', tiptapExtensions);
    expect(jsonToNode(TiptapTransformer.fromYdoc(encoded, 'default')).toJSON()).toEqual(expected);
    encoded.destroy();
    doc.destroy();
  });
});
