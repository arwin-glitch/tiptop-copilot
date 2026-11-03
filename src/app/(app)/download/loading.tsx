import { TabLoading } from '@/components/shell/tab-loading';
import { PAGE_HEADERS } from '@/lib/shell/page-headers';

/** Shown the moment the tab is clicked: the header, then placeholder shapes. */
export default function DownloadLoading() {
  return <TabLoading header={PAGE_HEADERS.download} body="detail" />;
}
