import { TabLoading } from '@/components/shell/tab-loading';
import { UPDATES_TABS } from '@/lib/records-tabs';
import { PAGE_HEADERS } from '@/lib/shell/page-headers';

/** Shown the moment the tab is clicked: the header, then placeholder shapes. */
export default function UpdatesLoading() {
  return (
    <TabLoading
      header={PAGE_HEADERS.updates}
      tabs={UPDATES_TABS.tabs.map((t) => t.label)}
      body="list"
    />
  );
}
