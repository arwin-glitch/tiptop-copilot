import { TabLoading } from '@/components/shell/tab-loading';
import { PORTFOLIO_TABS } from '@/lib/records-tabs';
import { PAGE_HEADERS } from '@/lib/shell/page-headers';

/** Shown the moment the tab is clicked: the header, then placeholder shapes. */
export default function PortfolioLoading() {
  return (
    <TabLoading
      header={PAGE_HEADERS.portfolio}
      tabs={PORTFOLIO_TABS.tabs.map((t) => t.label)}
      body="cards"
    />
  );
}
