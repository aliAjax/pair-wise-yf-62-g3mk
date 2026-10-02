'use client';

import { Alert, Button, Group, MultiSelect, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { useMemo, useState } from 'react';
import type { DispatchResult } from '@/lib/store';
import type { Mission, RescueAsset, SearchArea } from '@/lib/types';
import { isInWindow } from '@/lib/scheduling';
const missionSchema = z.object({
  title: z.string().min(3, '任务名称至少3个字'),
  areaId: z.string().min(1, '请选择搜索区'),
  priority: z.enum(['normal', 'urgent']),
  note: z.string().max(160),
});

type FormValues = z.infer<typeof missionSchema>;

interface DispatchFormProps {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  onDispatch: (input: FormValues & { assetIds: string[] }, expectedVersions: Record<string, number>) => DispatchResult;
  onSimulateConflict: (assetIds: string[]) => void;
}

export function DispatchForm({ areas, assets, missions, onDispatch, onSimulateConflict }: DispatchFormProps) {
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  // 占用版本快照：定格在挂载时；成功派单或冲突处理后才刷新。
  // 期间其他值班员写入会导致提交版本过期，从而触发乐观锁冲突。
  const [versions, setVersions] = useState<Record<string, number>>(() =>
    Object.fromEntries(assets.map((a) => [a.id, a.version])),
  );
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(missionSchema),
    defaultValues: { title: '', areaId: areas[0]?.id, priority: 'urgent', note: '' },
  });

  const areaData = useMemo(
    () =>
      areas.map((area) => ({
        value: area.id,
        label: `${area.name}（${area.status === 'active' ? '执行中' : area.status === 'closed' ? '已关闭' : '规划中'}）`,
        disabled: area.status !== 'active',
      })),
    [areas],
  );

  const assetData = useMemo(
    () =>
      assets.map((asset) => {
        const busy = missions.some(
          (m) => (m.status === 'dispatched' || m.status === 'in_progress') && m.assetIds.includes(asset.id),
        );
        const inWindow = isInWindow(asset, Date.now());
        const exhausted = asset.enduranceRemaining <= 0;
        const disabled = asset.status === 'offline' || busy || !inWindow || exhausted;
        const reasons = [
          asset.status === 'offline' ? '离线' : '',
          busy ? '在任务中' : '',
          !inWindow ? '不在可用时段' : '',
          exhausted ? '续航耗尽' : '',
        ].filter(Boolean);
        return {
          value: asset.id,
          label: `${asset.name} · 占用版本 v${asset.version}${reasons.length ? ` · ${reasons.join('/')}` : ''}`,
          disabled,
        };
      }),
    [assets, missions],
  );

  const submit = (values: FormValues) => {
    const result = onDispatch({ ...values, assetIds: selectedAssets }, versions);
    if (!result.ok) {
      setFormError(result.error);
      if (result.conflictAssetIds) {
        // 后到的提交看到版本已变化：清空冲突单位、刷新快照，重新选择
        const conflictSet = new Set(result.conflictAssetIds);
        setSelectedAssets((prev) => prev.filter((id) => !conflictSet.has(id)));
        setVersions(Object.fromEntries(assets.map((a) => [a.id, a.version])));
      }
      return;
    }
    setFormError(null);
    // 自己的写入生效后，快照推进到新版本
    setVersions(result.versions);
    reset({ title: '', areaId: areas.find((a) => a.status === 'active')?.id, priority: 'urgent', note: '' });
    setSelectedAssets([]);
  };

  return (
    <form onSubmit={handleSubmit(submit)}>
      <Stack mt="md">
        <Alert color="cyan" variant="light" title="派单规则">
          <Text size="xs">
            搜索区须执行中 · 单位在可用时段内 · 剩余续航 &gt; 0 · 同一单位不能同时挂两个进行中任务 · 占用版本先写入生效
          </Text>
        </Alert>
        {formError && (
          <Alert color="red" variant="light" title="派单未生效" withCloseButton onClose={() => setFormError(null)}>
            {formError}
          </Alert>
        )}
        <TextInput label="任务名称" {...register('title')} error={errors.title?.message} />
        <Controller
          control={control}
          name="areaId"
          render={({ field }) => (
            <Select
              label="搜索区"
              data={areaData}
              value={field.value}
              onChange={field.onChange}
              allowDeselect={false}
              error={errors.areaId?.message}
            />
          )}
        />
        <MultiSelect
          label="调派单位（可多选）"
          data={assetData}
          value={selectedAssets}
          onChange={setSelectedAssets}
          placeholder="选择单位，灰色为不可调派"
          clearable
        />
        <Text size="xs" c="dimmed">
          占用版本随派单/释放递增；提交时携带读取版本，冲突时先写入的生效。
        </Text>
        <Controller
          control={control}
          name="priority"
          render={({ field }) => (
            <Select
              label="优先级"
              data={[
                { value: 'urgent', label: '紧急' },
                { value: 'normal', label: '常规' },
              ]}
              value={field.value}
              onChange={field.onChange}
              allowDeselect={false}
            />
          )}
        />
        <Textarea label="任务说明" {...register('note')} />
        <Group justify="space-between">
          <Button type="submit">派发任务</Button>
          <Button
            variant="light"
            color="grape"
            onClick={() => onSimulateConflict(selectedAssets.length ? selectedAssets : assets.filter((a) => a.status !== 'offline').map((a) => a.id))}
          >
            模拟另一值班员抢先提交
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
