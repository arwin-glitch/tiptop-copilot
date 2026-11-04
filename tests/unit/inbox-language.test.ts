import { describe, expect, it } from 'vitest';
import { looksEnglish } from '@/lib/email/language';

describe('looksEnglish', () => {
  it('reads plain English as English', () => {
    expect(
      looksEnglish(
        'Hi there, thanks for the call last week. I wanted to follow up on the numbers we discussed and share the deck.',
      ),
    ).toBe(true);
  });

  it('flags Spanish, French and non-Latin scripts', () => {
    expect(
      looksEnglish(
        'Hola, muchas gracias por la reunión de ayer. Te escribo para compartir la presentación y los números que comentamos.',
      ),
    ).toBe(false);
    expect(
      looksEnglish(
        "Bonjour, merci beaucoup pour notre échange d'hier. Je vous envoie la présentation et les chiffres dont nous avons parlé.",
      ),
    ).toBe(false);
    expect(
      looksEnglish(
        'こんにちは、昨日はお時間をいただきありがとうございました。資料をお送りします。よろしくお願いします。',
      ),
    ).toBe(false);
  });

  it('never offers a translation for short text', () => {
    expect(looksEnglish('Gracias!')).toBe(true);
    expect(looksEnglish('')).toBe(true);
  });
});

describe('the demo mailbox', () => {
  it('holds one message in another language, so Translate message shows in the demo', async () => {
    const { demoFolderThreads } = await import('@/lib/demo/inbox-folder-fixtures');
    const texts = demoFolderThreads(new Date()).flatMap((t) => t.messages.map((m) => m.text));
    expect(texts.filter((t) => !looksEnglish(t))).toHaveLength(1);
  });
});
