'use client';

import { Badge, Button, Card, Group, Progress, Stack, Text, ThemeIcon } from '@mantine/core';
import { formatDistanceToNow, format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type { AssetStatus, RescueAsset } from '@/lib/types';
import { isInWindow, isPositionStale } from '@/lib/scheduling';

interface AssetPanelProps {
  assets: RescueAsset[];
  now: number;
  onChangeStatus: (id: string, status: AssetStatus) => void;
  onReport: (id: string) => void;
  onEndurance: (id: string) => void;
}

const typeLabel: Record<RescueAsset['type'], string> = {
  ship: '船艇',
  helicopter: '直升机',
  drone: '无人机',
  shore: '岸上点',
};

function fmtWindow(asset: RescueAsset): string {
  const f = (iso: string) => format(new Date(iso), 'HH:mm');
  return `${f(asset.availableFrom)}-${f(asset.availableTo)}`;
}

export function AssetPanel({ assets, now, onChangeStatus, onReport, onEndurance }: AssetPanelProps) {
  return (
    <Stack mt="md">
      {assets.map((asset) => {
        const stale = isPositionStale(asset, now);
        const inWindow = isInWindow(asset, now);
        const endurancePct = asset.enduranceMinutes > 0
          ? Math.max(0, Math.round((asset.enduranceRemaining / asset.enduranceMinutes) * 100))
          : 0;
        return (
          <Card key={asset.id} withBorder padding="sm">
            <Group justify="space-between">
              <Group gap="xs">
                <ThemeIcon size="sm" variant="light" color={asset.type === 'helicopter' ? 'blue' : 'cyan'}>
                  {typeLabel[asset.type].slice(0, 1)}
                </ThemeIcon>
                <b>{asset.name}</b>
                <Text size="xs" c="dimmed">{typeLabel[asset.type]}</Text>
              </Group>
              <Group gap="xs">
                <Badge size="xs" variant="outline" color="gray">v{asset.version}</Badge>
                <Badge color={asset.status === 'offline' ? 'red' : asset.status === 'assigned' ? 'blue' : 'teal'}>
                  {asset.status === 'offline' ? '失联' : asset.status === 'assigned' ? '执行中' : '待命'}
                </Badge>
              </Group>
            </Group>
            <Text size="xs" c={stale ? 'red' : 'dimmed'} mt={4}>
              {stale ? '位置已过期 · ' : ''}
              {formatDistanceToNow(new Date(asset.lastSeen), { addSuffix: true, locale: zhCN })}
              {' · '}
              {asset.lat.toFixed(3)}, {asset.lng.toFixed(3)}
            </Text>
            <Group mt={4} gap="xs">
              <Text size="xs" c={inWindow ? 'dimmed' : 'orange'}>
                可用时段 {fmtWindow(asset)}{inWindow ? '' : '（当前不在时段内）'}
              </Text>
            </Group>
            <Group mt={4} gap="xs" align="center">
              <Text size="xs" c={asset.enduranceRemaining <= 0 ? 'red' : 'dimmed'} style={{ minWidth: 64 }}>
                续航 {asset.enduranceRemaining} 分钟
              </Text>
              <Progress
                value={endurancePct}
                color={endurancePct < 20 ? 'red' : endurancePct < 50 ? 'yellow' : 'teal'}
                style={{ flex: 1 }}
              />
            </Group>
            <Group mt="xs">
              <Button
                size="compact-xs"
                variant="light"
                onClick={() => onChangeStatus(asset.id, asset.status === 'offline' ? 'ready' : 'offline')}
              >
                {asset.status === 'offline' ? '恢复在线' : '标记失联'}
              </Button>
              <Button size="compact-xs" variant="light" color="blue" onClick={() => onReport(asset.id)}>
                上报位置
              </Button>
              <Button
                size="compact-xs"
                variant="light"
                color="orange"
                onClick={() => onEndurance(asset.id)}
                disabled={asset.enduranceRemaining <= 0}
              >
                消耗续航
              </Button>
            </Group>
          </Card>
        );
      })}
    </Stack>
  );
}
