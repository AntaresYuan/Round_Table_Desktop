import { describe, expect, it } from 'vitest';
import { bundlePreviewHtml, withBundledPreview } from '../src/ui/lib/preview-html.js';

describe('preview HTML bundling', () => {
  it('inlines workspace-relative stylesheets and scripts for srcDoc previews', () => {
    const artifacts = [
      {
        kind: 'preview',
        title: 'panasonic-lens-site/index.html',
        preview: [
          '<!doctype html>',
          '<html>',
          '<head>',
          '<link rel="stylesheet" href="css/styles.css">',
          '<link rel="stylesheet" href="https://cdn.example.com/reset.css">',
          '</head>',
          '<body>',
          '<script src="js/data.js"></script>',
          '<script defer src="./js/app.js"></script>',
          '<script src="/shared/ignored.js"></script>',
          '</body>',
          '</html>',
        ].join(''),
      },
      {
        kind: 'code',
        title: 'panasonic-lens-site/css/styles.css',
        code: 'body { color: red; }',
      },
      {
        kind: 'code',
        title: 'panasonic-lens-site/js/data.js',
        code: 'window.lensData = [];',
      },
      {
        kind: 'code',
        title: 'panasonic-lens-site/js/app.js',
        code: 'window.appStarted = true;',
      },
    ];

    const html = bundlePreviewHtml(artifacts[0]!, artifacts);

    expect(html).toContain('data-roundtable-inline="panasonic-lens-site/css/styles.css"');
    expect(html).toContain('body { color: red; }');
    expect(html).not.toContain('href="css/styles.css"');
    expect(html).toContain('data-roundtable-inline="panasonic-lens-site/js/data.js"');
    expect(html).toContain('window.lensData = [];');
    expect(html).toContain('defer data-roundtable-inline="panasonic-lens-site/js/app.js"');
    expect(html).toContain('window.appStarted = true;');
    expect(html).toContain('https://cdn.example.com/reset.css');
    expect(html).toContain('src="/shared/ignored.js"');
  });

  it('returns a preview artifact with bundled local assets without changing the title', () => {
    const artifacts = [
      {
        kind: 'preview',
        title: 'site/index.html',
        preview: '<html><head><link href="./style.css" rel="stylesheet"></head><body></body></html>',
      },
      {
        kind: 'code',
        title: 'site/style.css',
        preview: '.hero { display: grid; }',
      },
    ];

    const bundled = withBundledPreview(artifacts[0]!, artifacts);

    expect(bundled.title).toBe('site/index.html');
    expect(bundled.preview).toContain('.hero { display: grid; }');
    expect(bundled.preview).not.toContain('href="./style.css"');
  });
});
