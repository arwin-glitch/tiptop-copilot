import { TabLoading } from '@/components/shell/tab-loading';
import { DIAGNOSTICS_TABS } from '@/lib/records-tabs';
import { PAGE_HEADERS } from '@/lib/shell/page-headers';

/** Shown the moment the tab is clicked: the header, then placeholder shapes. */
export default function DiagnosticsLoading() {
  return (
    <TabLoading
      header={PAGE_HEADERS.diagnostics}
      tabs={DIAGNOSTICS_TABS.tabs.map((t) => t.label)}
      body="list"
    />
  );
}
