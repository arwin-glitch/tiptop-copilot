import { TabLoading } from '@/components/shell/tab-loading';
import { SPACE_TABS } from '@/lib/records-tabs';
import { PAGE_HEADERS } from '@/lib/shell/page-headers';

/** Shown the moment a Space is opened: its tab bar, then placeholder rows. */
export default function SpaceLoading() {
  return (
    <TabLoading
      header={{ title: PAGE_HEADERS.spaces.title }}
      tabs={SPACE_TABS.tabs.map((t) => t.label)}
      body="list"
    />
  );
}
