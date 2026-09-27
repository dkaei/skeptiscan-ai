import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import App from '../src/App';

it('does not claim screenshot analysis is unavailable before capability discovery', () => {
  // Effects do not run during this initial render: there is no API/network call.
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/check/screenshot'] }, createElement(App)));
  expect(html).toContain('Checking screenshot availability');
  expect(html).not.toContain('Screenshot analysis is not available');
  expect(html).not.toContain('Screenshot availability could not be confirmed');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check screenshot<\/button>/);
});

it('exposes optional screenshot context and a non-submitting text entry before the first check', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/check/screenshot'] }, createElement(App)));
  expect(html).toMatch(/<input[^>]*id="input-context"[^>]*maxLength="500"[^>]*value=""/);
  expect(html).toContain('Context');
  expect(html).toMatch(/<button[^>]*type="button"[^>]*>Add text /);
  expect(html).not.toContain('id="input-content"');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check screenshot<\/button>/);
});
