import { describe, expect, it } from 'vitest';
import { parseDashboardContent, templateContent, templateHash, TEMPLATES } from './index.js';
import { GRID_COLUMNS } from './types.js';

describe('default dashboard templates', () => {
  it('have unique keys', () => {
    const keys = TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  for (const template of TEMPLATES) {
    describe(template.key, () => {
      const content = templateContent(template);

      it('becomes content that passes save-time validation unchanged', () => {
        expect(parseDashboardContent(content)).toEqual(content);
      });

      it('lays out panels inside the grid without overlaps', () => {
        for (const row of content.rows) {
          const cells = new Set<string>();
          for (const { id, layout } of row.panels) {
            expect(layout.x + layout.w, id).toBeLessThanOrEqual(GRID_COLUMNS);
            for (let x = layout.x; x < layout.x + layout.w; x++) {
              for (let y = layout.y; y < layout.y + layout.h; y++) {
                const cell = `${x},${y}`;
                expect(cells.has(cell), `${row.id}/${id} overlaps at ${cell}`).toBe(false);
                cells.add(cell);
              }
            }
          }
        }
      });
    });
  }

  it('fingerprints templates so changes can be noticed', () => {
    const [first, second] = TEMPLATES;
    expect(templateHash(first)).toMatch(/^[0-9a-f]{16}$/);
    expect(templateHash(first)).toBe(templateHash(first));
    expect(templateHash(first)).not.toBe(templateHash(second));
    expect(templateHash({ ...first, title: `${first.title} 2` })).not.toBe(templateHash(first));
  });
});
