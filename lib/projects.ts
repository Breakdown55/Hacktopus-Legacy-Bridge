import type { Project } from './types';

export const storageKey = 'legacy-bridge-projects-v1';
export const stages = ['Import', 'Select', 'Modernize', 'Verify', 'Export'];

export function projectPath(id: string, stage?: number) {
  const root = '/projects/' + encodeURIComponent(id);
  return stage === undefined ? root : root + '/' + stages[stage].toLowerCase();
}

export const headings = [
  ['Import executable', 'Upload the executable you want to modernize and add any project context.'],
  ['Select features', 'Choose the parts of the legacy application you want to modernize.'],
  ['Modularize code', 'Review how the selected features will be separated and packaged.'],
  ['Verify results', 'Review the verification checks before exporting.'],
  ['Export package', 'Review the project contents before downloading.'],
];

export function createTemplates(): Project[] {
  const now = Date.now();
  return [
    { id: 'banking', name: 'Banking tools', description: 'Taxes and Stocks', complete: 3, edited: now - 172800000, needs: true, source: 'banking.ts', features: ['Taxes', 'Stocks', 'Deposit'], selected: ['Taxes', 'Stocks'], demo: true },
    { id: 'billing', name: 'Billing portal', description: 'Invoicing and payments', complete: 5, edited: now - 604800000, source: 'billing.ts', features: ['Invoicing', 'Payments'], selected: ['Invoicing', 'Payments'], demo: true },
    { id: 'inventory', name: 'Inventory app', description: 'Stock and ordering', complete: 1, edited: now - 10800000, source: 'inventory.ts', features: ['Stock', 'Ordering'], selected: ['Stock', 'Ordering'], demo: true },
  ];
}

export function loadProjects(): Project[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) as string);
    return Array.isArray(saved) ? saved : createTemplates();
  } catch {
    return createTemplates();
  }
}

export function age(time: number): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (elapsed < 1) return 'just now';
  for (const [unit, size] of [['week', 10080], ['day', 1440], ['hour', 60], ['minute', 1]] as const) {
    if (elapsed >= size) {
      const n = Math.floor(elapsed / size);
      return n + ' ' + unit + (n !== 1 ? 's' : '') + ' ago';
    }
  }
  return 'just now';
}

export function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadPlan(project: Project) {
  const result = {
    name: project.name,
    description: project.description,
    source: project.source || '',
    notes: project.notes || '',
    selectedFeatures: project.selected,
    plannedTools: project.selected.map(s => s + '.ts'),
    plannedTests: project.selected.map(s => s + '.test.ts'),
  };
  const name = (project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'legacy-bridge') + '-plan.json';
  downloadFile(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), name);
}
