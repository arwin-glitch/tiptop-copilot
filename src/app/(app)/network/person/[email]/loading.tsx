import { TabLoading } from '@/components/shell/tab-loading';

/** Shown the moment a person is opened: the header, then placeholder shapes. */
export default function PersonLoading() {
  return (
    <TabLoading
      header={{ title: 'Person', subtitle: 'From mail and calendar' }}
      tabs={['Overview', 'Emails', 'Meetings']}
      body="list"
    />
  );
}
