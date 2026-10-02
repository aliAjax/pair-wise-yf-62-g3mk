'use client';

import { Badge, Button, Card, Group, Progress, Table, Text, Title } from '@mantine/core';
import type { AreaStatus, Mission, SearchArea } from '@/lib/types';

interface AreaPanelProps {
  areas: SearchArea[];
  missions: Mission[];
  onChangeStatus: (id: string, status: AreaStatus) => void;
}

const statusBadge = (status: AreaStatus) =>
  status === 'active' ? (
    <Badge color="teal">执行中</Badge>
  ) : status === 'closed' ? (
    <Badge color="red">已关闭</Badge>
  ) : (
    <Badge color="amber">规划中</Badge>
  );

export function AreaPanel({ areas, missions, onChangeStatus }: AreaPanelProps) {
  return (
    <Card withBorder>
      <Title order={3}>搜索区与覆盖率</Title>
      <Table mt="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>搜索区</Table.Th>
            <Table.Th>状态</Table.Th>
            <Table.Th style={{ width: '34%' }}>覆盖率</Table.Th>
            <Table.Th>操作</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {areas.map((area) => {
            const returned = missions.filter(
              (m) => m.areaId === area.id && m.status === 'returned',
            ).length;
            return (
              <Table.Tr key={area.id}>
                <Table.Td>
                  <Text fw={600}>{area.name}</Text>
                  {returned > 0 && (
                    <Text size="xs" c="red">
                      {returned} 个任务已失效退回
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{statusBadge(area.status)}</Table.Td>
                <Table.Td>
                  <Progress value={area.coverage} color={area.status === 'closed' ? 'red' : 'teal'} />
                  <Text size="xs" c="dimmed" mt={4}>
                    {area.coverage}%
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    {area.status !== 'active' && (
                      <Button size="compact-xs" variant="light" onClick={() => onChangeStatus(area.id, 'active')}>
                        转入执行
                      </Button>
                    )}
                    {area.status !== 'closed' && (
                      <Button size="compact-xs" color="red" variant="light" onClick={() => onChangeStatus(area.id, 'closed')}>
                        关闭
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed" mt="xs">
        关闭搜索区将退回区内所有进行中任务、释放单位并重算覆盖率；已完成任务继续留档。
      </Text>
    </Card>
  );
}
