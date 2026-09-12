/**
 * Table/Chart/Image-caption skeletons (§1/§2): the repo has no
 * table or chart element kind at all (`SlideElementKind` — `format.ts`), and
 * no image-caption data representation either — nothing here can accept a
 * command. These three sections exist only so the panel's "one screenshot
 * per type" acceptance criterion has something to render; every control in
 * them is permanently `disabled` and none of them are wired to any command.
 */

export function TableSkeletonSection() {
  return (
    <fieldset className="style-section style-section-skeleton" data-section="table">
      <legend>Table</legend>
      <p className="style-section-note">表格元素尚未支援，此區塊僅供預覽版面</p>
      <label className="style-field" data-attr="table-theme">
        <span className="style-field-label">Theme</span>
        <select data-attr="table-theme" disabled value="">
          <option value="">—</option>
        </select>
      </label>
      <label className="style-field" data-attr="table-borders">
        <span className="style-field-label">Borders</span>
        <input type="text" data-attr="table-borders" disabled value="" />
      </label>
    </fieldset>
  );
}

export function ChartSkeletonSection() {
  return (
    <fieldset className="style-section style-section-skeleton" data-section="chart">
      <legend>Chart</legend>
      <p className="style-section-note">圖表元素尚未支援，此區塊僅供預覽版面</p>
      <label className="style-field" data-attr="chart-palette">
        <span className="style-field-label">Palette</span>
        <select data-attr="chart-palette" disabled value="">
          <option value="">—</option>
        </select>
      </label>
    </fieldset>
  );
}

export interface ImageCaptionSkeletonSectionProps {
  /** Only rendered when at least one selected element carries `media !== null`. */
  visible: boolean;
}

export function ImageCaptionSkeletonSection({ visible }: ImageCaptionSkeletonSectionProps) {
  if (!visible) return null;
  return (
    <fieldset className="style-section style-section-skeleton" data-section="image">
      <legend>Image</legend>
      <label className="style-field" data-attr="image-caption">
        <span className="style-field-label">Caption</span>
        <input type="text" data-attr="image-caption" disabled value="" placeholder="尚未支援" />
      </label>
    </fieldset>
  );
}
