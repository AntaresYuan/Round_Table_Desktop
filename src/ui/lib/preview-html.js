/* ============================================================================
   Preview HTML helpers

   Generated sites are stored as one artifact per workspace file. Browser
   `srcDoc` previews do not have a workspace-relative base URL, so local CSS/JS
   references need to be inlined from sibling artifacts before rendering.
   ============================================================================ */

function artifactTitle(artifact) {
  const raw = artifact?.title || artifact?.path || artifact?.uri || '';
  return String(raw).replace(/^workspace:\/\//, '');
}

function artifactContent(artifact) {
  return artifact?.code ?? artifact?.preview ?? artifact?.content ?? '';
}

function normalizePath(path) {
  const parts = [];
  for (const part of String(path || '').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function dirname(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

function isLocalRef(ref) {
  const value = String(ref || '').trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function resolveRef(basePath, ref) {
  if (!isLocalRef(ref)) return null;
  const cleanRef = String(ref).split(/[?#]/)[0];
  if (!cleanRef) return null;
  const base = dirname(basePath);
  return normalizePath(cleanRef.startsWith('/') ? cleanRef.slice(1) : `${base}/${cleanRef}`);
}

function attrValue(tag, name) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function removeAttr(attrs, name) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  return attrs.replace(pattern, '').trim();
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function assetMap(artifacts) {
  const byPath = new Map();
  for (const artifact of artifacts || []) {
    const title = normalizePath(artifactTitle(artifact));
    const content = artifactContent(artifact);
    if (title && content) byPath.set(title, String(content));
  }
  return byPath;
}

function inlineStylesheets(html, basePath, byPath) {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = attrValue(tag, 'rel').toLowerCase();
    const href = attrValue(tag, 'href');
    if (!rel.split(/\s+/).includes('stylesheet')) return tag;
    const resolved = resolveRef(basePath, href);
    const css = resolved ? byPath.get(resolved) : null;
    if (!resolved || !css) return tag;
    return `<style data-roundtable-inline="${escapeAttr(resolved)}">\n${css}\n</style>`;
  });
}

function inlineScripts(html, basePath, byPath) {
  return html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs) => {
    const src = attrValue(tag, 'src');
    const resolved = resolveRef(basePath, src);
    const js = resolved ? byPath.get(resolved) : null;
    if (!resolved || !js) return tag;
    const keptAttrs = removeAttr(attrs, 'src');
    const attrText = keptAttrs ? ` ${keptAttrs}` : '';
    return `<script${attrText} data-roundtable-inline="${escapeAttr(resolved)}">\n${js}\n</script>`;
  });
}

function bundlePreviewHtml(artifact, artifacts) {
  const html = artifactContent(artifact);
  if (!html) return '';
  const basePath = artifactTitle(artifact);
  const byPath = assetMap(artifacts);
  return inlineScripts(inlineStylesheets(String(html), basePath, byPath), basePath, byPath);
}

function withBundledPreview(artifact, artifacts) {
  if (!artifact || !(artifact.kind === 'preview' || artifact.kind === 'html')) return artifact;
  const bundled = bundlePreviewHtml(artifact, artifacts);
  return bundled && bundled !== (artifact.preview || artifact.code || '')
    ? { ...artifact, preview: bundled }
    : artifact;
}

function bundlePreviewArtifacts(artifacts) {
  return (artifacts || []).map((artifact) => withBundledPreview(artifact, artifacts));
}

export { bundlePreviewHtml, withBundledPreview, bundlePreviewArtifacts, normalizePath };
