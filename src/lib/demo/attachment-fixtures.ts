/**
 * Demo mode only: two fictional attachment files for the demo Inbox, so
 * the attachment preview (image and PDF) works without a mailbox. Generated
 * once: a bar chart in Kraken's emerald and gold, and a one-page PDF with
 * invented figures. Served by /api/inbox/attachment in demo mode alone.
 */

export interface DemoAttachmentFile {
  id: string;
  name: string;
  mimeType: string;
  base64: string;
}

export const DEMO_ATTACHMENTS: readonly DemoAttachmentFile[] = [
  {
    id: 'demo-att-renewal-quote',
    name: 'renewal-quote.pdf',
    mimeType: 'application/pdf',
    base64:
      'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAyMDEgPj4Kc3RyZWFtCkJUIC9GMSAyMCBUZiA2MCA3MjAgVGQgKFdvcmtzcGFjZSBQcm8gcmVuZXdhbCBxdW90ZSkgVGogRVQKQlQgL0YxIDEyIFRmIDYwIDY5MCBUZCAoRGVtbyBkb2N1bWVudCAtIGZpY3Rpb25hbCBmaWd1cmVzIG9ubHkuKSBUaiBFVApCVCAvRjEgMTIgVGYgNjAgNjcwIFRkIChUZWFtIHBsYW4sIDEyIHNlYXRzOiAyMCUgb2ZmIGZvciBhIHllYXIuKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDQ5MyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjU2MwolJUVPRgo=',
  },
  {
    id: 'demo-att-plan-chart',
    name: 'plan-comparison.png',
    mimeType: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAIAAADN17N/AAAB+ElEQVR42u3UUQ2AMAxF0TlBCh6wMVe4wQm/JAiYinZZd5Ir4IWe0f7vlcrUfAIBLQEtAS0BLaAloCWgJaAloAW0BLQEtAS0BPQKHf3KCWgBDbSABhpooIEGGmiggQZaQAMtoIEGGmiggQYaaKCBFtBAC2iggQYaaKCBhglooAU00AIaaKCBBhpooAU00AIaaAENNNBAAw000OjMoQM00EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBrgUYHaKCBBhpoq4AG2iqggQYaaHSABhpooIG2CmigrQIaHaCBRgdooIEGGmirgAbaKqDRARpodIAGGmiggbYKaKCtAhodoIFGx6qYZwa0VUA7klVAO5JVQKNjFdBWAQ20VUA7klVAO5JVQKNjFdBWAQ20VUA7klVAO5JVQKNjFdBWAQ20VUA7klVAO5JVQKMDNNBWAQ20VUA7klVAo2MV0OgADbRVQANtFdCOZBXQ6FgFNDpAA20V0EBbBbQjWQU0OlYBbRXQQFsFtCNZBbQjWQU0OlYBbdXuoJ/7lMoU+IeW8gNaQEtAS0BLQAtoCWgJaCmyAYnHpaHs7nU/AAAAAElFTkSuQmCC',
  },
];

export function demoAttachment(id: string): DemoAttachmentFile | null {
  return DEMO_ATTACHMENTS.find((a) => a.id === id) ?? null;
}
