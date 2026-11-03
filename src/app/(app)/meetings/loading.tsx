import { TabLoading } from '@/components/shell/tab-loading';
import { MEETINGS_TABS } from '@/lib/records-tabs';
import { PAGE_HEADERS } from '@/lib/shell/page-headers';

/** Shown the moment the tab is clicked: the header, then placeholder shapes. */
export default function MeetingsLoading() {
  return (
    <TabLoading
      header={PAGE_HEADERS.meetings}
      tabs={MEETINGS_TABS.tabs.map((t) => t.label)}
      body="list"
    />
  );
}
