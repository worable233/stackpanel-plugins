'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PageHeader,
} from '@stackpanel/ui';
import EmojiPickerLib, { EmojiStyle } from 'emoji-picker-react';
import { FolderTree, Plus } from 'lucide-react';

interface CategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  productCount: number;
  children: CategoryNode[];
}

interface EmojiPickerProps {
  value: string | null;
  onChange: (emoji: string) => void;
}

function EmojiPicker({ value, onChange }: EmojiPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    function compute() {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ top: rect.bottom + 4, left: rect.left });
    }
    compute();
    function onDocClick(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.epr-main')) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('resize', compute);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('resize', compute);
    };
  }, [open]);

  const picker = (
    <div
      className="z-50 rounded-xl border bg-card shadow-lg"
      style={position ? { position: 'fixed', top: position.top, left: position.left } : undefined}
    >
      <EmojiPickerLib
        width={340}
        height={400}
        emojiStyle={EmojiStyle.NATIVE}
        onEmojiClick={(data) => {
          onChange(data.emoji);
          setOpen(false);
        }}
      />
    </div>
  );

  return (
    <>
      <Button ref={buttonRef} type="button" variant="outline" onClick={() => setOpen((v) => !v)}>
        <span className="text-base leading-none">{value ?? '🙂'}</span>
        <span className="text-xs text-muted-foreground">图标</span>
      </Button>
      {open && position && typeof window !== 'undefined'
        ? createPortal(picker, document.body)
        : null}
    </>
  );
}

/** 扁平化树（先序），用于拖拽排序与提交。 */
function flattenTree(
  nodes: readonly CategoryNode[],
  parentId: string | null = null,
): Array<{ id: string; parentId: string | null; sortOrder: number }> {
  const flat: Array<{
    id: string;
    parentId: string | null;
    sortOrder: number;
  }> = [];
  nodes.forEach((node, index) => {
    flat.push({ id: node.id, parentId, sortOrder: index });
    flat.push(...flattenTree(node.children, node.id));
  });
  return flat;
}

/** 统计树中的节点总数（用于拖拽重排完整性校验）。 */
function countNodes(nodes: readonly CategoryNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    count += countNodes(node.children);
  }
  return count;
}

/** `node` 的子树中是否包含 `targetId`（用于阻止拖成自身后代）。 */
function isAncestor(node: CategoryNode, targetId: string): boolean {
  for (const child of node.children) {
    if (child.id === targetId) return true;
    if (isAncestor(child, targetId)) return true;
  }
  return false;
}

/** 根据拖拽后的扁平顺序重建树。 */
function buildTree(
  flat: Array<{ id: string; parentId: string | null; sortOrder: number }>,
  byId: Map<string, CategoryNode>,
): CategoryNode[] {
  const nodes = new Map<string, CategoryNode & { children: CategoryNode[] }>();
  for (const item of flat) {
    const source = byId.get(item.id);
    if (!source) continue;
    nodes.set(item.id, { ...source, children: [] });
  }
  const roots: CategoryNode[] = [];
  for (const item of flat) {
    const node = nodes.get(item.id);
    if (!node) continue;
    if (item.parentId && nodes.has(item.parentId)) {
      nodes.get(item.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** 分类管理页：拖拽树 + emoji + 编辑/删除。 */
export function CatalogAdminPage(props: AdminPageComponentProps): ReactElement {
  const data = props.data as {
    categories?: CategoryNode[];
    productCounts?: Record<string, number>;
  };
  const initial = data.categories ?? [];
  const [categories, setCategories] = useState<CategoryNode[]>(initial);
  const [draftName, setDraftName] = useState('');
  const [draftIcon, setDraftIcon] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reorderToken, setReorderToken] = useState(0);
  const [pendingFlat, setPendingFlat] = useState<Array<{
    id: string;
    parentId: string | null;
    sortOrder: number;
  }> | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    id: string;
    position: 'before' | 'inside' | 'after';
  } | null>(null);
  const dropIndicatorRef = useRef<{
    id: string;
    position: 'before' | 'inside' | 'after';
  } | null>(null);

  const actions = props.actions as Record<string, (formData: FormData) => Promise<void>>;
  const createAction = actions['catalog.create-category'];
  const updateAction = actions['catalog.update-category'];
  const deleteAction = actions['catalog.delete-category'];
  const reorderAction = actions['catalog.reorder-categories'];

  const byId = useMemo(() => {
    const map = new Map<string, CategoryNode>();
    const visit = (nodes: readonly CategoryNode[]) => {
      for (const node of nodes) {
        map.set(node.id, node);
        visit(node.children);
      }
    };
    visit(categories);
    return map;
  }, [categories]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const flat = useMemo(() => flattenTree(categories), [categories]);
  const [dragId, setDragId] = useState<string | null>(null);
  const pointerYRef = useRef(0);

  useEffect(() => {
    if (!dragId) return;
    const onMove = (event: PointerEvent) => {
      pointerYRef.current = event.clientY;
    };
    // 捕获阶段先于 dnd-kit 内部处理器更新指针坐标，供 onDragOver 判定。
    window.addEventListener('pointermove', onMove, true);
    return () => window.removeEventListener('pointermove', onMove, true);
  }, [dragId]);

  function handleDragStart(event: DragStartEventLike) {
    setDragId(String(event.active.id));
  }

  function handleDragMove(_event: DragMoveEventLike) {
    const activeId = String(_event.active.id);
    const pointerY = pointerYRef.current;
    // 用真实指针位置自行命中目标行，避免 dnd-kit 的 over 因卡片高度偏移。
    const rowEls = Array.from(document.querySelectorAll<HTMLElement>('[data-row-id]'));
    let target: { id: string; top: number; height: number } | null = null;
    for (const el of rowEls) {
      if (el.dataset.rowId === activeId) continue;
      const rect = el.getBoundingClientRect();
      if (pointerY >= rect.top && pointerY <= rect.bottom) {
        target = {
          id: el.dataset.rowId ?? '',
          top: rect.top,
          height: rect.height,
        };
        break;
      }
    }
    if (!target) {
      dropIndicatorRef.current = null;
      setDropIndicator(null);
      return;
    }
    const ratio = target.height > 0 ? (pointerY - target.top) / target.height : 0.5;
    const position: 'before' | 'inside' | 'after' =
      ratio < 0.33 ? 'before' : ratio > 0.66 ? 'after' : 'inside';
    dropIndicatorRef.current = { id: target.id, position };
    setDropIndicator(dropIndicatorRef.current);
  }

  function handleDragEnd(event: DragEndEventLike) {
    const activeId = String(event.active.id);
    const drop = dropIndicatorRef.current;
    setDragId(null);
    setDropIndicator(null);
    dropIndicatorRef.current = null;
    if (!activeId || !drop || drop.id === activeId) return;
    const overId = drop.id;
    const position = drop.position;
    setCategories((current) => {
      const currentById = new Map<string, CategoryNode>();
      const visit = (nodes: readonly CategoryNode[]) => {
        for (const node of nodes) {
          currentById.set(node.id, node);
          visit(node.children);
        }
      };
      visit(current);
      const activeNode = currentById.get(activeId);
      if (!activeNode) return current;
      const overNode = currentById.get(overId);
      if (!overNode) return current;

      // 阻止把节点拖成自己的后代（active 是 over 的祖先时，退化为同级插入）。
      let targetParentId: string | null;
      if (position === 'inside') {
        if (isAncestor(activeNode, overId)) {
          targetParentId = overNode.parentId;
        } else {
          targetParentId = overId;
        }
      } else {
        targetParentId = overNode.parentId;
      }

      // 从原位置移除 active
      const flatCurrent = flattenTree(current);
      const activeIndex = flatCurrent.findIndex((item) => item.id === activeId);
      if (activeIndex < 0) return current;
      const newFlat = [...flatCurrent];
      newFlat.splice(activeIndex, 1);
      const overIndex = newFlat.findIndex((item) => item.id === overId);
      let insertIndex: number;
      if (position === 'after') {
        insertIndex = overIndex < 0 ? newFlat.length : overIndex + 1;
      } else {
        // before 或 inside：插到 over 之前；inside 时 over 成为父级。
        insertIndex = overIndex < 0 ? newFlat.length : overIndex;
      }
      newFlat.splice(insertIndex, 0, {
        id: activeId,
        parentId: targetParentId,
        sortOrder: 0,
      });
      // 重新编号 sortOrder
      const reindexed = newFlat.map((item, index) => ({
        ...item,
        sortOrder: index,
      }));
      setPendingFlat(reindexed);
      // 用当前节点数据重建树，避免闭包里的旧 byId 丢失节点。
      const freshById = new Map<string, CategoryNode>();
      const visitFresh = (nodes: readonly CategoryNode[]) => {
        for (const node of nodes) {
          freshById.set(node.id, node);
          visitFresh(node.children);
        }
      };
      visitFresh(current);
      const rebuilt = buildTree(reindexed, freshById);
      // 防御：重建结果为空或节点数减少时，保留当前树，避免误清空。
      if (rebuilt.length === 0 && current.length > 0) return current;
      if (countNodes(rebuilt) < countNodes(current)) return current;
      return rebuilt;
    });
  }

  function submitReorder() {
    if (!reorderAction || !pendingFlat) return;
    const formData = new FormData();
    for (const item of pendingFlat) {
      formData.append('ids', item.id);
      formData.append('parentIds', item.parentId ?? '__root__');
      formData.append('sortOrders', String(item.sortOrder));
    }
    void reorderAction(formData);
    setPendingFlat(null);
    setReorderToken((v) => v + 1);
  }

  return (
    <main className="w-full space-y-6">
      <PageHeader
        title="商品分类"
        actions={
          <>
            {reorderAction && pendingFlat ? (
              <Button variant="outline" onClick={submitReorder}>
                保存排序
              </Button>
            ) : null}
            {createAction ? (
              <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
                <Plus className="size-4" />
                新建分类
              </Button>
            ) : null}
          </>
        }
      />

      {categories.length ? (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
        >
          <div className="space-y-2">
            {flat.map((item) => {
              const node = byId.get(item.id)!;
              return (
                <SortableRow
                  key={item.id}
                  node={node}
                  depth={depthOf(item.id, flat)}
                  dragging={dragId === item.id}
                  dropIndicator={dropIndicator?.id === item.id ? dropIndicator.position : null}
                  onEditStart={() => {
                    setEditingId(item.id);
                    setEditName(node.name);
                    setEditIcon(node.icon);
                  }}
                  onDeleteRequest={() => setConfirmDelete(item.id)}
                  deleteAction={deleteAction}
                />
              );
            })}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragId ? (
              <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2 shadow-lg">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">
                  {byId.get(dragId)?.icon ?? '🙂'}
                </span>
                <span className="truncate text-sm font-medium">{byId.get(dragId)?.name}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <Empty text="暂无分类" />
      )}
      {/* 触发 server action 的重排表单（由拖拽后提交） */}
      <input type="hidden" value={reorderToken} onChange={() => undefined} aria-hidden />

      {createOpen && createAction ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setCreateOpen(false);
              setDraftName('');
              setDraftIcon(null);
            }
          }}
        >
          <DialogContent className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !max-w-md !translate-x-0 !translate-y-0 !rounded-none !border-y-0 !border-r-0 data-open:slide-in-from-right data-closed:slide-out-to-right">
            <DialogHeader>
              <DialogTitle>新建分类</DialogTitle>
              <DialogDescription>创建后可在列表中拖拽调整层级与顺序。</DialogDescription>
            </DialogHeader>
            <form action={createAction} className="grid gap-4 py-2">
              <input name="icon" type="hidden" value={draftIcon ?? ''} onChange={() => undefined} />
              <div className="flex items-end gap-3">
                <EmojiPicker value={draftIcon} onChange={setDraftIcon} />
                <div className="grid flex-1 gap-1.5">
                  <Label htmlFor="create-category-name">名称</Label>
                  <Input
                    id="create-category-name"
                    name="name"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    required
                  />
                </div>
              </div>
              <DialogFooter className="flex-row justify-end">
                <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                  取消
                </Button>
                <Button type="submit">创建</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {editingId && updateAction ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingId(null);
          }}
        >
          <DialogContent className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !max-w-md !translate-x-0 !translate-y-0 !rounded-none !border-y-0 !border-r-0 data-open:slide-in-from-right data-closed:slide-out-to-right">
            <DialogHeader>
              <DialogTitle>编辑分类</DialogTitle>
              <DialogDescription>修改分类名称与图标。</DialogDescription>
            </DialogHeader>
            <form action={updateAction} className="grid gap-4 py-2">
              <input type="hidden" name="id" value={editingId} />
              <input type="hidden" name="icon" value={editIcon ?? ''} onChange={() => undefined} />
              <div className="flex items-end gap-3">
                <EmojiPicker value={editIcon} onChange={setEditIcon} />
                <div className="grid flex-1 gap-1.5">
                  <Label htmlFor="edit-category-name">名称</Label>
                  <Input
                    id="edit-category-name"
                    name="name"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    required
                  />
                </div>
              </div>
              <DialogFooter className="flex-row justify-end">
                <Button type="button" variant="ghost" onClick={() => setEditingId(null)}>
                  取消
                </Button>
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {confirmDelete && deleteAction ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmDelete(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>删除分类</DialogTitle>
              <DialogDescription>删除后，该分类下的商品将变为未分类。确定删除？</DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-row justify-end">
              <Button type="button" variant="ghost" onClick={() => setConfirmDelete(null)}>
                取消
              </Button>
              <Button type="submit" variant="destructive" form={`delete-category-${confirmDelete}`}>
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  );
}

type DragStartEventLike = { active: { id: unknown } };
type DragMoveEventLike = { active: { id: unknown } };
type DragEndEventLike = { active: { id: unknown } };

function depthOf(
  id: string,
  flat: Array<{ id: string; parentId: string | null; sortOrder: number }>,
): number {
  let depth = 0;
  let current = id;
  const byId = new Map(flat.map((item) => [item.id, item]));
  for (let guard = 0; guard < flat.length; guard += 1) {
    const item = byId.get(current);
    if (!item || !item.parentId) break;
    depth += 1;
    current = item.parentId;
  }
  return depth;
}

function SortableRow({
  node,
  depth,
  dragging,
  dropIndicator,
  onEditStart,
  onDeleteRequest,
  deleteAction,
}: {
  node: CategoryNode;
  depth: number;
  dragging: boolean;
  dropIndicator: 'before' | 'inside' | 'after' | null;
  onEditStart: () => void;
  onDeleteRequest: () => void;
  deleteAction?: (formData: FormData) => Promise<void>;
}): ReactElement {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: node.id });
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: node.id });
  void dragging;
  void isOver;
  return (
    <div
      ref={setDropRef}
      data-row-id={node.id}
      className={`relative rounded-xl border bg-card ${
        isDragging
          ? 'opacity-50'
          : dropIndicator === 'inside'
            ? 'border-primary ring-2 ring-primary/30'
            : ''
      }`}
    >
      {dropIndicator === 'before' ? (
        <div
          className="absolute inset-x-0 top-0 h-0.5 -translate-y-1 rounded-full bg-primary"
          aria-hidden="true"
        />
      ) : null}
      {dropIndicator === 'after' ? (
        <div
          className="absolute inset-x-0 bottom-0 h-0.5 translate-y-1 rounded-full bg-primary"
          aria-hidden="true"
        />
      ) : null}
      <div
        className="flex items-center gap-3 px-3 py-2"
        style={{ paddingLeft: `${depth * 1.25 + 0.75}rem` }}
      >
        <Button
          ref={setDragRef}
          type="button"
          variant="ghost"
          size="icon"
          {...attributes}
          {...listeners}
          aria-label="拖拽排序"
          className="cursor-grab text-muted-foreground"
        >
          <span className="text-sm leading-none">⠿</span>
        </Button>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">
          {node.icon ?? '🙂'}
        </span>
        <span className="flex-1 truncate text-sm font-medium">{node.name}</span>
        {node.productCount > 0 ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
            {node.productCount}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onEditStart}>
            编辑
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDeleteRequest}>
            删除
          </Button>
        </div>
      </div>
      {deleteAction ? (
        <form id={`delete-category-${node.id}`} action={deleteAction} className="hidden">
          <input type="hidden" name="id" value={node.id} />
        </form>
      ) : null}
    </div>
  );
}

function Empty({ text }: { text: string }): ReactElement {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
      <FolderTree className="size-5 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-muted-foreground">{text}</p>
    </div>
  );
}

export const adminPages = {
  'admin/categories': CatalogAdminPage,
} as const;
