import { TabLoading } from '@/components/shell/tab-loading';
import { KNOWLEDGE_TABS } from '@/lib/records-tabs';
import { PAGE_HEADERS } from '@/lib/shell/page-headers';

/** Shown the moment the tab is clicked: the header, then placeholder shapes. */
export default function KnowledgeLoading() {
  return (
    <TabLoading
      header={PAGE_HEADERS.knowledge}
      tabs={KNOWLEDGE_TABS.tabs.map((t) => t.label)}
      body="list"
    />
  );
}
