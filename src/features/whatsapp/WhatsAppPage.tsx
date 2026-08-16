import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConnectionTab } from './ConnectionTab'
import { TemplatesTab } from './TemplatesTab'
import { AutomationsTab } from './AutomationsTab'
import { QueueHistoryTab } from './QueueHistoryTab'
import { DiagnosticsTab } from './DiagnosticsTab'

// Gate 8 — WhatsApp module. Own top-level nav tab per Doc 3 (not buried
// in Settings). Sub-sections consolidated sensibly from Doc 3's full
// list (Overview/Connection/Templates/Automations/Message Queue/
// History/Failed/Contacts/Settings/Diagnostics) into 5 tabs: Connection
// covers Overview+Connection+Settings' connection piece; Queue &
// History covers Message Queue+History+Failed together (same data,
// filtered by status) since splitting them into 3 separate screens for
// a lean V1 club would mostly show duplicate empty states.
export function WhatsAppPage() {
  const [activeTab, setActiveTab] = useState('connection')

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="واتساب" description="إدارة اتصال واتساب والقوالب والتنبيهات التلقائية" />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="connection">الاتصال</TabsTrigger>
          <TabsTrigger value="templates">القوالب</TabsTrigger>
          <TabsTrigger value="automations">التنبيهات التلقائية</TabsTrigger>
          <TabsTrigger value="queue">الرسائل</TabsTrigger>
          <TabsTrigger value="diagnostics">التشخيص</TabsTrigger>
        </TabsList>

        <TabsContent value="connection"><ConnectionTab /></TabsContent>
        <TabsContent value="templates"><TemplatesTab /></TabsContent>
        <TabsContent value="automations"><AutomationsTab /></TabsContent>
        <TabsContent value="queue"><QueueHistoryTab /></TabsContent>
        <TabsContent value="diagnostics"><DiagnosticsTab /></TabsContent>
      </Tabs>
    </div>
  )
}
