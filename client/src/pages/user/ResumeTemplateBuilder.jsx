import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors
} from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    ArrowLeft,
    Briefcase,
    CheckCircle2,
    Copy,
    Eye,
    FileText,
    GripVertical,
    LayoutList,
    Palette,
    Plus,
    Save,
    Settings2,
    Trash2,
    Type,
    UserRound
} from 'lucide-react';
import { userAPI } from '../../api';
import { PageLoader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/SelectField';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

// Fallback when /user/user-templates omits allowed_fonts (should not
// happen in normal builds). Keep in sync with server ALLOWED_FONTS.
const FALLBACK_FONTS = [
    'Arial', 'Arial Narrow', 'Helvetica', 'Helvetica Neue',
    'Times New Roman', 'Times', 'Georgia',
    'Courier New', 'Courier', 'Verdana', 'Tahoma',
    'Trebuchet MS', 'Lucida Sans Unicode', 'Lucida Grande', 'Segoe UI',
    'Calibri', 'Calibri Light', 'Cambria', 'Candara', 'Consolas',
    'Constantia', 'Corbel', 'Garamond', 'Book Antiqua',
    'Palatino', 'Palatino Linotype', 'Century Gothic',
    'Franklin Gothic Medium', 'Gill Sans', 'Gill Sans MT',
    'Futura', 'Optima', 'Baskerville', 'Didot', 'Avenir', 'Avenir Next',
    'Roboto', 'Roboto Condensed', 'Rubik', 'Lato', 'Montserrat', 'Open Sans',
    'Poppins', 'Inter', 'Source Sans Pro', 'Source Sans 3',
    'Source Serif Pro', 'Source Serif 4',
    'Nunito', 'Nunito Sans', 'Work Sans', 'Raleway', 'PT Sans', 'PT Serif',
    'Merriweather', 'Playfair Display', 'Lora', 'Libre Baskerville',
    'EB Garamond', 'Crimson Text', 'Spectral',
    'Noto Sans', 'Noto Serif', 'IBM Plex Sans', 'IBM Plex Serif',
    'Fira Sans', 'Ubuntu', 'Karla', 'Mulish', 'Manrope', 'Outfit', 'DM Sans',
    'Barlow', 'Overpass', 'Quicksand', 'Josefin Sans', 'Titillium Web',
    'Oswald', 'Space Grotesk', 'Exo 2'
];

// =============================================================================
// ResumeTemplateBuilder
// =============================================================================
// Drag-drop template builder for the user-side resume templates.
//
// Sections the user can reorder via drag-drop:
//   - blocks (Summary, Core Skills, Work Experience, Education)
//   - contact fields (city_state, email, phone, linkedin, github)
//
// Per-element controls:
//   - font (whitelisted via allowed_fonts from server)
//   - font size (half-points: 16 = 8pt, 20 = 10pt, 28 = 14pt, 32 = 16pt)
//   - alignment (left/center/right/justify)
//
// Experience-row layout:
//   - 'two_column'  -> job title (left) | dates (right) on same line
//   - 'stacked'     -> title and dates on consecutive lines (legacy look)
//
// Persistence: PUT /api/user/user-templates/:id  (handled by userTemplateService)
// =============================================================================

const FONT_SIZE_HALF_PT = [
    14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 44, 48, 52, 56, 60
];
const ALIGN_OPTIONS = [
    { value: 'left',    label: 'Left' },
    { value: 'center',  label: 'Center' },
    { value: 'right',   label: 'Right' },
    { value: 'justify', label: 'Justify' }
];
const ALIGN_LR_OPTIONS = ALIGN_OPTIONS.filter((o) => o.value !== 'justify');
const LINE_SPACING_OPTIONS = [
    { value: '1',    label: 'Single (1.0)' },
    { value: '1.15', label: '1.15' },
    { value: '1.35', label: '1.35 (default)' },
    { value: '1.5',  label: '1.5' },
    { value: '1.75', label: '1.75' },
    { value: '2',    label: 'Double (2.0)' }
];
const MARGIN_OPTIONS = [
    { value: '18',  label: '0.25″' },
    { value: '27',  label: '0.375″' },
    { value: '36',  label: '0.5″' },
    { value: '54',  label: '0.75″' },
    { value: '72',  label: '1″' },
    { value: '90',  label: '1.25″' },
    { value: '108', label: '1.5″' }
];
const SPACE_PT_OPTIONS = [0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24].map((n) => ({
    value: String(n),
    label: `${n}pt`
}));
const BULLET_OPTIONS = [
    { value: '•', label: '•  Round' },
    { value: '○', label: '○  Hollow' },
    { value: '▪', label: '▪  Square' },
    { value: '■', label: '■  Filled square' },
    { value: '◦', label: '◦  White bullet' },
    { value: '‣', label: '‣  Triangle' },
    { value: '–', label: '–  En dash' },
    { value: '—', label: '—  Em dash' },
    { value: '-', label: '-  Hyphen' },
    { value: '*', label: '*  Asterisk' }
];
const BORDER_SIZE_OPTIONS = [
    { value: '0.5',  label: '0.5pt (thin)' },
    { value: '0.75', label: '0.75pt' },
    { value: '1',    label: '1pt' },
    { value: '1.5',  label: '1.5pt' },
    { value: '2',    label: '2pt (thick)' }
];
const INDENT_OPTIONS = [0, 9, 12, 18, 24, 27, 36, 45, 54].map((n) => ({
    value: String(n),
    label: `${n}pt`
}));
const COLOR_OPTIONS = [
    { value: 'none',   label: 'Default (black)' },
    { value: '000000', label: 'Black' },
    { value: '111111', label: 'Near black' },
    { value: '333333', label: 'Dark gray' },
    { value: '1F4E79', label: 'Navy' },
    { value: '0D47A1', label: 'Blue' },
    { value: '1565C0', label: 'Sky blue' },
    { value: '1A6B5E', label: 'Teal' },
    { value: '2E7D32', label: 'Green' },
    { value: '4A148C', label: 'Purple' },
    { value: 'B71C1C', label: 'Red' },
    { value: '6D4C41', label: 'Brown' },
    { value: '37474F', label: 'Blue gray' }
];
const PAPER_OPTIONS = [
    { value: 'letter', label: 'US Letter (8.5×11″)' },
    { value: 'a4',     label: 'A4 (210×297 mm)' }
];

function ensureFontPool(spec) {
    if (!spec || typeof spec !== 'object') return spec;
    const body = { ...(spec.body || {}) };
    const primary = body.font || 'Arial';
    if (!Array.isArray(body.font_pool) || body.font_pool.length === 0) {
        body.font_pool = [primary];
    }
    return { ...spec, body };
}

// One-click packs similar to other resume generators.
const STYLE_PRESETS = [
    {
        id: 'classic',
        label: 'Classic ATS',
        hint: 'Arial, 0.5″ margins, underline bar',
        patch: {
            name: { font: 'Arial', size_half_pt: 36, bold: true, underline: false, italic: false, uppercase: false, color: null, align: 'center' },
            contact: { font: 'Arial', size_half_pt: 18, bold: false, underline: false, italic: false, color: null, align: 'center' },
            heading: {
                '2': { font: 'Arial', size_half_pt: 24, bold: true, align: 'left', color: null, uppercase: true, italic: false, underline: false,
                    border_bottom: { style: 'single', size_pt: 0.75, color: '000000', space_pt: 1 }, space_before_pt: 12, space_after_pt: 4 },
                '3': { font: 'Arial', size_half_pt: 22, bold: true, align: 'left', color: null, uppercase: false, italic: false, space_before_pt: 8, space_after_pt: 2 }
            },
            body: { font: 'Arial', font_pool: ['Arial', 'Calibri', 'Times New Roman'], size_half_pt: 20, align: 'left', line_spacing: 1.15, space_after_pt: 2, color: null },
            page: { paper_size: 'letter', margin_top_pt: 36, margin_bottom_pt: 36, margin_left_pt: 36, margin_right_pt: 36 },
            list: { bullet_char: '•', indent_left_pt: 18, indent_hanging_pt: 18, space_after_pt: 2 },
            experience_row: { layout: 'two_column', separator: '|', job_gap_pt: 8 },
            theme: { accent_color: null },
            contact_separator: '|'
        }
    },
    {
        id: 'compact',
        label: 'Compact',
        hint: 'Tighter spacing, Calibri, smaller type',
        patch: {
            name: { font: 'Calibri', size_half_pt: 32, bold: true, underline: false, italic: false, uppercase: false, color: null, align: 'center' },
            contact: { font: 'Calibri', size_half_pt: 16, bold: false, underline: false, italic: false, color: null, align: 'center' },
            heading: {
                '2': { font: 'Calibri', size_half_pt: 22, bold: true, align: 'left', color: null, uppercase: true, italic: false, underline: false,
                    border_bottom: { style: 'single', size_pt: 0.5, color: '333333', space_pt: 1 }, space_before_pt: 8, space_after_pt: 2 },
                '3': { font: 'Calibri', size_half_pt: 20, bold: true, align: 'left', color: null, uppercase: false, italic: false, space_before_pt: 4, space_after_pt: 1 }
            },
            body: { font: 'Calibri', font_pool: ['Calibri', 'Arial', 'Verdana'], size_half_pt: 18, align: 'left', line_spacing: 1.0, space_after_pt: 1, color: null },
            page: { paper_size: 'letter', margin_top_pt: 27, margin_bottom_pt: 27, margin_left_pt: 36, margin_right_pt: 36 },
            list: { bullet_char: '•', indent_left_pt: 14, indent_hanging_pt: 14, space_after_pt: 1 },
            experience_row: { layout: 'two_column', separator: '|', job_gap_pt: 4 },
            theme: { accent_color: null },
            contact_separator: '|'
        }
    },
    {
        id: 'modern-navy',
        label: 'Modern Navy',
        hint: 'Calibri + navy accents, no bar',
        patch: {
            name: { font: 'Calibri', size_half_pt: 40, bold: true, underline: false, italic: false, uppercase: false, color: '1F4E79', align: 'center' },
            contact: { font: 'Calibri', size_half_pt: 18, bold: false, underline: false, italic: false, color: '333333', align: 'center' },
            heading: {
                '2': { font: 'Calibri', size_half_pt: 24, bold: true, align: 'left', color: '1F4E79', uppercase: true, italic: false, underline: false,
                    border_bottom: { style: 'single', size_pt: 1.5, color: '1F4E79', space_pt: 1 }, space_before_pt: 12, space_after_pt: 4 },
                '3': { font: 'Calibri', size_half_pt: 22, bold: true, align: 'left', color: '1F4E79', uppercase: false, italic: false, space_before_pt: 8, space_after_pt: 2 }
            },
            body: { font: 'Calibri', font_pool: ['Calibri', 'Arial', 'Helvetica'], size_half_pt: 20, align: 'left', line_spacing: 1.15, space_after_pt: 2, color: null },
            page: { paper_size: 'letter', margin_top_pt: 36, margin_bottom_pt: 36, margin_left_pt: 45, margin_right_pt: 45 },
            list: { bullet_char: '▪', indent_left_pt: 18, indent_hanging_pt: 18, space_after_pt: 2 },
            experience_row: { layout: 'two_column', separator: '•', job_gap_pt: 8 },
            theme: { accent_color: '1F4E79' },
            contact_separator: '•'
        }
    },
    {
        id: 'executive',
        label: 'Executive',
        hint: 'Garamond, wider margins, serif body',
        patch: {
            name: { font: 'Garamond', size_half_pt: 44, bold: true, underline: false, italic: false, uppercase: false, color: null, align: 'center' },
            contact: { font: 'Garamond', size_half_pt: 18, bold: false, underline: false, italic: true, color: '333333', align: 'center' },
            heading: {
                '2': { font: 'Garamond', size_half_pt: 26, bold: true, align: 'center', color: null, uppercase: true, italic: false, underline: false,
                    border_bottom: null, space_before_pt: 14, space_after_pt: 6 },
                '3': { font: 'Garamond', size_half_pt: 22, bold: true, align: 'left', color: null, uppercase: false, italic: false, space_before_pt: 8, space_after_pt: 2 }
            },
            body: { font: 'Garamond', font_pool: ['Garamond', 'Georgia', 'Times New Roman'], size_half_pt: 22, align: 'left', line_spacing: 1.35, space_after_pt: 3, color: null },
            page: { paper_size: 'letter', margin_top_pt: 54, margin_bottom_pt: 54, margin_left_pt: 54, margin_right_pt: 54 },
            list: { bullet_char: '–', indent_left_pt: 20, indent_hanging_pt: 16, space_after_pt: 3 },
            experience_row: { layout: 'stacked', separator: '|', job_gap_pt: 10 },
            theme: { accent_color: null },
            contact_separator: '|'
        }
    },
    {
        id: 'a4-eu',
        label: 'A4 European',
        hint: 'A4 paper, Open Sans, teal accent',
        patch: {
            name: { font: 'Open Sans', size_half_pt: 36, bold: true, underline: false, italic: false, uppercase: false, color: '1A6B5E', align: 'left' },
            contact: { font: 'Open Sans', size_half_pt: 18, bold: false, underline: false, italic: false, color: null, align: 'left' },
            heading: {
                '2': { font: 'Open Sans', size_half_pt: 22, bold: true, align: 'left', color: '1A6B5E', uppercase: false, italic: false, underline: false,
                    border_bottom: { style: 'single', size_pt: 1, color: '1A6B5E', space_pt: 1 }, space_before_pt: 10, space_after_pt: 3 },
                '3': { font: 'Open Sans', size_half_pt: 20, bold: true, align: 'left', color: null, uppercase: false, italic: false, space_before_pt: 6, space_after_pt: 2 }
            },
            body: { font: 'Open Sans', font_pool: ['Open Sans', 'Calibri', 'Arial'], size_half_pt: 20, align: 'left', line_spacing: 1.15, space_after_pt: 2, color: null },
            page: { paper_size: 'a4', margin_top_pt: 36, margin_bottom_pt: 36, margin_left_pt: 45, margin_right_pt: 45 },
            list: { bullet_char: '•', indent_left_pt: 18, indent_hanging_pt: 18, space_after_pt: 2 },
            experience_row: { layout: 'two_column', separator: '|', job_gap_pt: 6 },
            theme: { accent_color: '1A6B5E' },
            contact_separator: '|'
        }
    }
];

function colorSelectValue(color) {
    return color || 'none';
}
function colorFromSelect(v) {
    return !v || v === 'none' ? null : v;
}

// --- Experience-row helpers (preview) ----------------------------------------
// Mirror the server renderer's segment-split for the live HTML preview.
// Returns the HTML for one job block (work-summary line + title row +
// bullet list) so what the user sees matches what gets rendered.
function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const SEP_CHARS = { '|': '|', '•': '•', ',': ',' };
// Render a list of visible segments inline on one row, separated by
// `sep`. Left-aligned segments sit on the left edge with `sep`
// between them. Right-aligned segments are grouped into a SINGLE
// inline block (joined by `sep`) and pushed to the right edge via
// `margin-left:auto` on the GROUP. This matches the server
// renderer's behavior: when both location and dates are right-
// aligned they read as "location, dates" on a single visual line
// (not stacked on two lines).
function renderInlineSegments(segments, sep) {
    const segStyle = (s) => {
        const italicStyle = s.italic ? 'font-style: italic;' : '';
        return `font-family:inherit;${italicStyle}`;
    };
    const visible = segments.filter(s => s.text);
    if (!visible.length) return '';

    const leftSegs = visible.filter(s => s.align !== 'right');
    const rightSegs = visible.filter(s => s.align === 'right');

    // Left side: each segment followed by the separator. The
    // trailing separator is intentionally omitted so the visual
    // matches the inline render in Word.
    const leftHtml = leftSegs
        .map((s, i) => {
            const prefix = i === 0 ? '' : `<span class="seg" style="font-family:inherit;padding: 0 4pt;">${escapeHtml(sep)}</span>`;
            return `${prefix}<span class="seg" style="${segStyle(s)}">${escapeHtml(s.text)}</span>`;
        })
        .join('');

    // Right side: a single inline block holding all right-aligned
    // segments joined by `sep`. The `margin-left:auto` pushes the
    // WHOLE BLOCK to the right edge — segments inside stay on the
    // same line because they have no auto margin of their own.
    const rightHtml = rightSegs.length
        ? (() => {
            const inner = rightSegs
                .map((s, i) => {
                    const prefix = i === 0 ? '' : `<span class="seg" style="font-family:inherit;padding: 0 4pt;">${escapeHtml(sep)}</span>`;
                    return `${prefix}<span class="seg" style="${segStyle(s)}">${escapeHtml(s.text)}</span>`;
                })
                .join('');
            return `<span class="seg" style="margin-left:auto;font-family:inherit;display:inline-block;">${inner}</span>`;
        })()
        : '';

    return `<div class="job">${leftHtml}${rightHtml}</div>`;
}

// Build the per-job preview HTML. Mirrors the server renderer's
// segment-split + wrap semantic. See the renderer's comments on
// `wrap_title_company` and `wrap_company_location` for the full
// rule set; this function returns the same paragraph layout.
function buildPreviewJob(job, er) {
    const sep = SEP_CHARS[er.separator] || '|';
    const showCompany  = er.show_company !== false;
    const showLocation = er.show_location !== false;
    const wrapTC = !!er.wrap_title_company;
    const wrapCL = !!er.wrap_company_location;

    const titleSeg    = { text: job.title,                                                  align: er.title_align    || 'left',  italic: !!er.title_italic };
    const companySeg  = { text: showCompany  ? job.company  : '', align: er.company_align  || 'left',  italic: !!er.company_italic };
    const locationSeg = { text: showLocation ? job.location : '', align: er.location_align || 'left',  italic: !!er.location_italic };
    const datesSeg    = { text: job.dates,                                                  align: er.dates_align    || 'right', italic: !!er.dates_italic };

    // Line 1: title + non-wrapped segments + dates.
    const line1 = [titleSeg];
    if (!wrapTC) line1.push(companySeg);
    if (!wrapCL) line1.push(locationSeg);
    line1.push(datesSeg);
    const line1Html = renderInlineSegments(line1, sep);

    const line2Html = (wrapTC && companySeg.text) ? renderInlineSegments([companySeg], sep) : '';
    const line3Html = (wrapCL && locationSeg.text) ? renderInlineSegments([locationSeg], sep) : '';

    const summary = er.work_summary
        ? `<p class="work-summary">${escapeHtml(job.summary || '')}</p>`
        : '';

    return summary + line1Html + line2Html + line3Html + `<ul>${job.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`;
}

// --- Sortable item wrapper ----------------------------------------------------
// Renders a single draggable row with a grip + a configurable body. Used for
// both blocks and contact-fields lists.
function SortableItem({ id, children, disabled }) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id, disabled });
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1
    };
    return (
        <div
            ref={setNodeRef}
            style={style}
            className={cn(
                'flex items-stretch gap-2 rounded-md border bg-white p-2',
                isDragging && 'shadow-lg ring-1 ring-blue-300'
            )}
        >
            <button
                type="button"
                className="flex w-6 cursor-grab items-center justify-center text-gray-400 hover:text-gray-600 active:cursor-grabbing"
                {...attributes}
                {...listeners}
                aria-label="Drag handle"
                disabled={disabled}
            >
                <GripVertical className="h-4 w-4" />
            </button>
            <div className="flex-1">{children}</div>
        </div>
    );
}

// --- Per-block controls -------------------------------------------------------
// Renders font + size + alignment controls for a single block row. Visibility
// toggle sits on the right.
function BlockControls({ block, onChange, allowedFonts }) {
    return (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
            <div className="md:col-span-4">
                <Label className="text-xs text-gray-500">Label</Label>
                <Input
                    value={block.label}
                    onChange={(e) => onChange({ ...block, label: e.target.value })}
                    className="h-8 text-sm"
                />
            </div>
            <div className="md:col-span-2">
                <Label className="text-xs text-gray-500">Visible</Label>
                <label className="flex h-8 items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={!!block.visible}
                        onChange={(e) => onChange({ ...block, visible: e.target.checked })}
                        className="h-4 w-4"
                    />
                    <span>{block.visible ? 'Yes' : 'No'}</span>
                </label>
            </div>
            <div className="md:col-span-6 text-xs text-gray-500 self-end">
                <span className="rounded bg-gray-100 px-1.5 py-0.5">id: {block.id}</span>
                <span className="ml-2">Reorder via the grip on the left.</span>
            </div>
        </div>
    );
}

// --- Per-contact-field controls ----------------------------------------------
// Each contact field can be hidden and its label can be overridden (e.g.
// "Email" -> "Email Address"). The actual value comes from the candidate
// profile; this row only controls whether/where it appears in the line.
function ContactFieldControls({ field, onChange }) {
    return (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
            <div className="md:col-span-4">
                <Label className="text-xs text-gray-500">Label</Label>
                <Input
                    value={field.label}
                    onChange={(e) => onChange({ ...field, label: e.target.value })}
                    className="h-8 text-sm"
                />
            </div>
            <div className="md:col-span-2">
                <Label className="text-xs text-gray-500">Visible</Label>
                <label className="flex h-8 items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={!!field.visible}
                        onChange={(e) => onChange({ ...field, visible: e.target.checked })}
                        className="h-4 w-4"
                    />
                    <span>{field.visible ? 'Yes' : 'No'}</span>
                </label>
            </div>
            <div className="md:col-span-6 text-xs text-gray-500 self-end">
                <span className="rounded bg-gray-100 px-1.5 py-0.5">source: {field.source}</span>
                <span className="ml-2">Drag to reorder. Value comes from the profile.</span>
            </div>
        </div>
    );
}

// --- Heading controls ---------------------------------------------------------
// One row per heading level (h1 = name, h2 = section title, h3 = subsection).
function HeadingControls({ rank, value, onChange, allowedFonts, showUnderline = true, showColor = true, showUppercase = true }) {
    return (
        <div className="space-y-2">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
            <div className="md:col-span-2">
                <Label className="text-xs text-gray-500">h{rank}</Label>
                <div className="rounded border bg-gray-50 px-2 py-1 text-sm">Heading {rank}</div>
            </div>
            <div className="md:col-span-3">
                <Label className="text-xs text-gray-500">Font</Label>
                <SelectField
                    value={value.font || 'Arial'}
                    onChange={(v) => onChange({ ...value, font: v })}
                        options={(allowedFonts?.length ? allowedFonts : FALLBACK_FONTS).map(f => ({ value: f, label: f }))}
                />
            </div>
                <div className="md:col-span-2">
                <Label className="text-xs text-gray-500">Size</Label>
                <SelectField
                    value={String(value.size_half_pt || 20)}
                    onChange={(v) => onChange({ ...value, size_half_pt: Number(v) })}
                    options={FONT_SIZE_HALF_PT.map(s => ({ value: String(s), label: `${s / 2}pt` }))}
                />
            </div>
            <div className="md:col-span-2">
                <Label className="text-xs text-gray-500">Align</Label>
                <SelectField
                    value={value.align || 'left'}
                    onChange={(v) => onChange({ ...value, align: v })}
                    options={ALIGN_OPTIONS}
                />
            </div>
                <div className="md:col-span-1">
                <Label className="text-xs text-gray-500">Bold</Label>
                <label className="flex h-9 items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={value.bold !== false}
                        onChange={(e) => onChange({ ...value, bold: e.target.checked })}
                        className="h-4 w-4"
                    />
                </label>
                </div>
                {showUnderline ? (
                    <div className="md:col-span-2">
                        <Label className="text-xs text-gray-500">Underline</Label>
                        <label className="flex h-9 items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={value.underline === true}
                                onChange={(e) => onChange({ ...value, underline: e.target.checked })}
                                className="h-4 w-4"
                            />
                            <span>{value.underline ? 'On' : 'Off'}</span>
                        </label>
                    </div>
                ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {showColor ? (
                    <div>
                        <Label className="text-xs text-gray-500">Color</Label>
                        <SelectField
                            value={colorSelectValue(value.color)}
                            onChange={(v) => onChange({ ...value, color: colorFromSelect(v) })}
                            options={COLOR_OPTIONS}
                        />
                    </div>
                ) : null}
                <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                        type="checkbox"
                        checked={value.italic === true}
                        onChange={(e) => onChange({ ...value, italic: e.target.checked })}
                        className="h-4 w-4"
                    />
                    Italic
                </label>
                {showUppercase ? (
                    <label className="flex items-end gap-2 pb-2 text-sm">
                        <input
                            type="checkbox"
                            checked={value.uppercase === true}
                            onChange={(e) => onChange({ ...value, uppercase: e.target.checked })}
                            className="h-4 w-4"
                        />
                        ALL CAPS
                    </label>
                ) : null}
            </div>
        </div>
    );
}

// Compact category block inside a settings tab.
function SettingsGroup({ title, hint, children }) {
    return (
        <div className="rounded-lg border border-border/70 bg-card/40 p-4">
            <div className="mb-3">
                <h4 className="text-sm font-semibold text-foreground">{title}</h4>
                {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            <div className="space-y-3">{children}</div>
        </div>
    );
}

const SETTINGS_TABS = [
    { id: 'general',     label: 'General',     icon: Settings2 },
    { id: 'header',      label: 'Header',      icon: UserRound },
    { id: 'sections',    label: 'Sections',    icon: LayoutList },
    { id: 'experience',  label: 'Experience',  icon: Briefcase },
    { id: 'typography',  label: 'Typography',  icon: Type },
    { id: 'colors',      label: 'Colors',      icon: Palette },
    { id: 'page',        label: 'Page',        icon: FileText }
];

// =============================================================================
// Main component
// =============================================================================
export default function ResumeTemplateBuilder() {
    const { templateId } = useParams();
    const navigate = useNavigate();
    const isNew = !templateId || templateId === 'new';

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [allowedFonts, setAllowedFonts] = useState([]);
    const [library, setLibrary] = useState([]);        // user's other templates
    // Admin-uploaded templates (every user sees the same list — it
    // is NOT filtered per-user). The ResumeGenerator picker uses
    // these too; surfacing them here gives the builder a one-stop
    // reference of "what's available to pick from" without flipping
    // between pages.
    const [adminTemplates, setAdminTemplates] = useState([]);
    const [currentId, setCurrentId] = useState(null);
    const [isDefault, setIsDefault] = useState(false);
    const [spec, setSpec] = useState(null);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [toast, setToast] = useState(null);            // { kind: 'ok' | 'err', text }
    const [previewHtml, setPreviewHtml] = useState('');
    const [previewing, setPreviewing] = useState(false);

    // dnd-kit sensors. PointerSensor activates after a small distance so
    // single clicks (e.g. checkbox toggle, text input) don't trigger a
    // drag. KeyboardSensor keeps the builder accessible: focus a grip
    // and press Space/Arrow keys to reorder.
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    // ---- Initial load: library + (template or fresh spec) ----
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                // Always load the library so the picker at the top stays
                // in sync with the user's other templates.
                const libRes = await userAPI.listUserTemplates();
                if (cancelled) return;
                setLibrary(libRes.data.templates || []);
                setAllowedFonts(libRes.data.allowed_fonts?.length
                    ? libRes.data.allowed_fonts
                    : FALLBACK_FONTS);

                // Also load the admin-uploaded templates list. The
                // endpoint is the same /user/resume-templates route the
                // ResumeGenerator uses; it returns every admin
                // template (default + custom) and is NOT filtered per
                // user, so every team member sees the same set. The
                // load is best-effort: if it fails the builder still
                // works (the reference section just stays empty).
                try {
                    const adminRes = await userAPI.listTemplates();
                    if (!cancelled && Array.isArray(adminRes?.data?.templates)) {
                        setAdminTemplates(adminRes.data.templates);
                    }
                } catch (adminErr) {
                    console.warn('Failed to load admin templates:', adminErr);
                }

                // Bare /user/templates (no id) → open the default or
                // first existing template so the nav link lands on an
                // editable page. Explicit /user/templates/new still
                // starts a blank draft.
                if (!templateId) {
                    const list = libRes.data.templates || [];
                    if (list.length) {
                        const preferred = list.find((t) => t.is_default) || list[0];
                        navigate(`/user/templates/${preferred.id}`, { replace: true });
                        return;
                    }
                }

                if (isNew) {
                    // Fresh spec — call the default-spec endpoint so the
                    // server's sanitiser is the single source of truth for
                    // shape, not the client.
                    const def = await userAPI.getUserTemplateDefaultSpec();
                    if (cancelled) return;
                    setSpec(ensureFontPool(def.data.style_spec));
                    // Default the name to "My Template" only when no row
                    // with that name already exists for this user — the
                    // user_resume_templates table has a UNIQUE(user_id,
                    // name) constraint and the server can't tell from
                    // "create vs update" alone whether the user has
                    // already accepted this name on a prior save.
                    // Pre-pending the timestamp avoids the silent
                    // auto-rename to "My Template (copy)" on every first
                    // save after the auto-seed runs.
                    const existingNames = new Set((libRes.data.templates || []).map(t => t.name));
                    const defaultName = 'My Template';
                    setName(existingNames.has(defaultName) ? `My Template (${new Date().toISOString().slice(0, 10)})` : defaultName);
                    setDescription('');
                    setCurrentId(null);
                    setIsDefault(false);
                } else {
                    const r = await userAPI.getUserTemplate(templateId);
                    if (cancelled) return;
                    setSpec(ensureFontPool(r.data.template.style_spec));
                    setName(r.data.template.name);
                    setDescription(r.data.template.description || '');
                    setCurrentId(r.data.template.id);
                    setIsDefault(!!r.data.template.is_default);
                }
            } catch (e) {
                if (!cancelled) showToast('err', e.response?.data?.error || e.message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [templateId, isNew, navigate]);

    // ---- Toast helper ----
    function showToast(kind, text) {
        setToast({ kind, text });
        setTimeout(() => setToast(null), 3500);
    }

    // ---- Drag-end handlers ----
    // dnd-kit passes the active + over ids; arrayMove swaps the rows in
    // the spec immutably so React re-renders the reordered list.
    function onBlocksDragEnd(e) {
        const { active, over } = e;
        if (!over || active.id === over.id) return;
        setSpec((s) => {
            const oldIndex = s.blocks.findIndex(b => b.id === active.id);
            const newIndex = s.blocks.findIndex(b => b.id === over.id);
            if (oldIndex < 0 || newIndex < 0) return s;
            return { ...s, blocks: arrayMove(s.blocks, oldIndex, newIndex) };
        });
    }
    function onContactsDragEnd(e) {
        const { active, over } = e;
        if (!over || active.id === over.id) return;
        setSpec((s) => {
            const oldIndex = s.contact_fields.findIndex(b => b.id === active.id);
            const newIndex = s.contact_fields.findIndex(b => b.id === over.id);
            if (oldIndex < 0 || newIndex < 0) return s;
            return { ...s, contact_fields: arrayMove(s.contact_fields, oldIndex, newIndex) };
        });
    }

    // ---- Block / contact patchers ----
    function updateBlock(id, patch) {
        setSpec((s) => ({
            ...s,
            blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b))
        }));
    }
    function updateContactField(id, patch) {
        setSpec((s) => ({
            ...s,
            contact_fields: s.contact_fields.map((f) => (f.id === id ? { ...f, ...patch } : f))
        }));
    }
    function updateHeading(rank, patch) {
        setSpec((s) => ({
            ...s,
            heading: { ...s.heading, [String(rank)]: { ...s.heading[String(rank)], ...patch } }
        }));
    }
    function updateBody(patch) {
        setSpec((s) => {
            const body = { ...s.body, ...patch };
            if (patch.font_pool) {
                const pool = [...new Set(patch.font_pool.filter(Boolean))];
                body.font_pool = pool.length ? pool : [body.font || 'Arial'];
                if (!body.font_pool.includes(body.font)) {
                    body.font = body.font_pool[0];
                }
            } else if (patch.font) {
                const prevPool = Array.isArray(s.body?.font_pool) ? s.body.font_pool : [];
                if (!prevPool.includes(patch.font)) {
                    body.font_pool = [...prevPool, patch.font];
                }
            }
            const fonts = (patch.font || body.font)
                ? { ...s.fonts, body: body.font, default: body.font }
                : s.fonts;
            return { ...s, body, fonts };
        });
    }

    function addFontToPool(fontName) {
        if (!fontName) return;
        setSpec((s) => {
            const pool = Array.isArray(s.body?.font_pool) ? [...s.body.font_pool] : [s.body?.font || 'Arial'];
            if (!pool.includes(fontName)) pool.push(fontName);
            const body = {
                ...s.body,
                font: s.body?.font || fontName,
                font_pool: pool
            };
            return {
                ...s,
                body,
                fonts: { ...s.fonts, body: body.font, default: body.font }
            };
        });
    }

    function removeFontFromPool(fontName) {
        setSpec((s) => {
            const pool = (Array.isArray(s.body?.font_pool) ? s.body.font_pool : [s.body?.font || 'Arial'])
                .filter((f) => f !== fontName);
            const nextPool = pool.length ? pool : ['Arial'];
            const nextFont = nextPool.includes(s.body?.font) ? s.body.font : nextPool[0];
            return {
                ...s,
                body: { ...s.body, font: nextFont, font_pool: nextPool },
                fonts: { ...s.fonts, body: nextFont, default: nextFont }
            };
        });
    }
    function updateNameSlot(patch) {
        setSpec((s) => {
            const nameSlot = { ...s.name, ...patch };
            const fonts = patch.font
                ? { ...s.fonts, heading: patch.font }
                : s.fonts;
            return { ...s, name: nameSlot, fonts };
        });
    }
    function updateContactSlot(patch) {
        setSpec((s) => ({ ...s, contact: { ...s.contact, ...patch } }));
    }
    function updateExperienceRow(patch) {
        setSpec((s) => ({ ...s, experience_row: { ...s.experience_row, ...patch } }));
    }
    function updatePage(patch) {
        setSpec((s) => ({ ...s, page: { ...(s.page || {}), ...patch } }));
    }
    function updateList(patch) {
        setSpec((s) => ({ ...s, list: { ...(s.list || {}), ...patch } }));
    }
    function updateTheme(patch) {
        setSpec((s) => ({ ...s, theme: { ...(s.theme || {}), ...patch } }));
    }
    function applyAccentColor(raw) {
        const color = colorFromSelect(raw);
        setSpec((s) => {
            const h2 = { ...(s.heading?.['2'] || {}), color };
            if (h2.border_bottom) {
                h2.border_bottom = { ...h2.border_bottom, color: color || '000000' };
            }
            return {
                ...s,
                theme: { ...(s.theme || {}), accent_color: color },
                name: { ...s.name, color },
                heading: {
                    ...s.heading,
                    '2': h2,
                    '3': { ...(s.heading?.['3'] || {}), color }
                }
            };
        });
    }
    function applyPreset(preset) {
        if (!preset?.patch) return;
        setSpec((s) => {
            const p = preset.patch;
            return {
                ...s,
                name: { ...s.name, ...p.name },
                contact: { ...s.contact, ...p.contact },
                body: { ...s.body, ...p.body },
                page: { ...s.page, ...p.page },
                list: { ...s.list, ...p.list },
                theme: { ...(s.theme || {}), ...p.theme },
                contact_separator: p.contact_separator || s.contact_separator,
                experience_row: { ...s.experience_row, ...p.experience_row },
                heading: {
                    ...s.heading,
                    '2': { ...(s.heading?.['2'] || {}), ...(p.heading?.['2'] || {}) },
                    '3': { ...(s.heading?.['3'] || {}), ...(p.heading?.['3'] || {}) }
                }
            };
        });
        showToast('ok', `Applied “${preset.label}”`);
    }
    function updateSectionLabel(key, value) {
        setSpec((s) => {
            const labels = { ...(s.section_labels || {}) };
            if (value && value.trim()) labels[key] = value.trim();
            else delete labels[key];
            return { ...s, section_labels: labels };
        });
    }

    // ---- Persist (create or update) ----
    async function save() {
        if (!name.trim()) {
            showToast('err', 'Template name is required');
            return;
        }
        setSaving(true);
        try {
            const payload = {
                name: name.trim(),
                description,
                style_spec: spec,
                is_default: isDefault
            };
            let r;
            if (currentId) {
                r = await userAPI.updateUserTemplate(currentId, payload);
            } else {
                r = await userAPI.createUserTemplate({ ...payload, is_default: true });
            }
            showToast('ok', `Saved “${r.data.template.name}”`);
            setCurrentId(r.data.template.id);
            if (r.data.template.style_spec) {
                setSpec(ensureFontPool(r.data.template.style_spec));
            }
            setIsDefault(!!r.data.template.is_default);
            // Refresh the library so the picker reflects the new/updated row.
            const lib = await userAPI.listUserTemplates();
            setLibrary(lib.data.templates || []);
            // For a brand-new template, swap to its dedicated URL so a
            // page reload lands on the same record.
            if (isNew && r.data.template.id) {
                navigate(`/user/templates/${r.data.template.id}`, { replace: true });
            }
        } catch (e) {
            showToast('err', e.response?.data?.error || e.message);
        } finally {
            setSaving(false);
        }
    }

    // ---- Delete ----
    async function remove() {
        if (!currentId) return;
        if (!window.confirm(`Delete template “${name}”? This cannot be undone.`)) return;
        try {
            await userAPI.deleteUserTemplate(currentId);
            showToast('ok', 'Template deleted');
            navigate('/user/templates/new');
        } catch (e) {
            showToast('err', e.response?.data?.error || e.message);
        }
    }

    // ---- Duplicate ----
    async function duplicate() {
        if (!currentId) return;
        try {
            const r = await userAPI.createUserTemplate({
                name: `${name} (copy)`,
                description,
                style_spec: spec,
                is_default: false
            });
            showToast('ok', 'Duplicated');
            navigate(`/user/templates/${r.data.template.id}`);
        } catch (e) {
            showToast('err', e.response?.data?.error || e.message);
        }
    }

    // ---- Live preview ----
    // Renders the spec into a static HTML preview using the same rules
    // the DOCX renderer applies (2-column tabs, section order, font
    // sizes). We keep this entirely client-side so the preview updates
    // as the user drags / edits without a server round-trip.
    useMemo(() => {
        if (!spec) { setPreviewHtml(''); return; }
        const visibleBlocks = spec.blocks.filter(b => b.visible);
        const order = visibleBlocks.map(b => b.id);
        // Heading text for the preview: prefer the user's custom
        // `section_labels[key]` (the new "Section heading text" card)
        // when set, fall back to the per-block `b.label` (the existing
        // "Label" input under block controls), and finally to the
        // block id capitalised. Same precedence the server's
        // reorderBySpec applies when generating the DOCX, so the
        // preview and the output stay in sync.
        const blockLabels = Object.fromEntries(spec.blocks.map(b => [
            b.id,
            spec.section_labels?.[b.id] || b.label || (b.id[0].toUpperCase() + b.id.slice(1))
        ]));

        // Inline CSS for the preview. Mirrors templateRenderer's DOCX
        // shape closely enough that fonts/sizes/alignments line up.
        // The `.job` rule uses flexbox so right-aligned segments
        // (margin-left:auto) sit flush-right and other segments stack
        // inline on the left — same visual outcome as the DOCX tab
        // stop on the right edge.
        const page = spec.page || {};
        const list = spec.list || {};
        const h2 = spec.heading?.['2'] || {};
        const h3 = spec.heading?.['3'] || {};
        const bulletChar = list.bullet_char || '•';
        const styles = `
            body {
                font-family: "${spec.body?.font || 'Arial'}", Arial, sans-serif;
                font-size: ${(spec.body?.size_half_pt || 20) / 2}pt;
                line-height: ${spec.body?.line_spacing || 1.35};
                margin: ${page.margin_top_pt ?? 36}pt ${page.margin_right_pt ?? 36}pt ${page.margin_bottom_pt ?? 36}pt ${page.margin_left_pt ?? 36}pt;
                color: #${spec.body?.color || '111111'};
                text-align: ${spec.body?.align || 'left'};
            }
            h1 {
                font-family: "${spec.name?.font || spec.body?.font || 'Arial'}", Arial, sans-serif;
                text-align: ${spec.name?.align || 'center'};
                font-size: ${(spec.name?.size_half_pt || 32) / 2}pt;
                font-weight: ${spec.name?.bold !== false ? 'bold' : 'normal'};
                font-style: ${spec.name?.italic ? 'italic' : 'normal'};
                text-decoration: ${spec.name?.underline ? 'underline' : 'none'};
                text-transform: ${spec.name?.uppercase ? 'uppercase' : 'none'};
                color: #${spec.name?.color || '111111'};
                margin: 0 0 6pt 0;
            }
            .contact {
                font-family: "${spec.contact?.font || spec.body?.font || 'Arial'}", Arial, sans-serif;
                text-align: ${spec.contact?.align || 'center'};
                font-size: ${(spec.contact?.size_half_pt || 20) / 2}pt;
                font-weight: ${spec.contact?.bold ? 'bold' : 'normal'};
                font-style: ${spec.contact?.italic ? 'italic' : 'normal'};
                text-decoration: ${spec.contact?.underline ? 'underline' : 'none'};
                color: #${spec.contact?.color || '111111'};
                margin-bottom: 12pt;
            }
            h2 {
                font-family: "${h2.font || spec.body?.font || 'Arial'}", Arial, sans-serif;
                font-size: ${(h2.size_half_pt || 28) / 2}pt;
                font-weight: ${h2.bold !== false ? 'bold' : 'normal'};
                font-style: ${h2.italic ? 'italic' : 'normal'};
                text-decoration: ${h2.underline ? 'underline' : 'none'};
                text-transform: ${h2.uppercase ? 'uppercase' : 'none'};
                text-align: ${h2.align || 'left'};
                color: #${h2.color || '111111'};
                margin: ${h2.space_before_pt ?? 10}pt 0 ${h2.space_after_pt ?? 3}pt 0;
                ${h2.border_bottom ? `border-bottom: ${h2.border_bottom.size_pt || 0.75}pt solid #${h2.border_bottom.color || '000000'};` : ''}
                padding-bottom: 2pt;
            }
            h3 {
                font-family: "${h3.font || spec.body?.font || 'Arial'}", Arial, sans-serif;
                font-size: ${(h3.size_half_pt || 22) / 2}pt;
                font-weight: ${h3.bold !== false ? 'bold' : 'normal'};
                font-style: ${h3.italic ? 'italic' : 'normal'};
                text-decoration: ${h3.underline ? 'underline' : 'none'};
                text-transform: ${h3.uppercase ? 'uppercase' : 'none'};
                text-align: ${h3.align || 'left'};
                color: #${h3.color || '111111'};
                margin: ${h3.space_before_pt ?? (spec.experience_row?.job_gap_pt ?? 6)}pt 0 ${h3.space_after_pt ?? 2}pt 0;
            }
            .job { display: flex; flex-wrap: wrap; align-items: baseline; font-weight: bold; margin-top: 6pt; gap: 4pt; }
            .job.job-wrapped { flex-direction: column; align-items: flex-start; }
            .job .seg { display: inline-block; }
            .work-summary { font-style: italic; margin: 4pt 0 4pt 0; color: #222; }
            p { margin: 0 0 ${spec.body?.space_after_pt ?? 2}pt 0; }
            ul {
                margin: 4pt 0 4pt 0;
                padding-left: ${list.indent_left_pt ?? 18}pt;
                list-style: none;
            }
            li {
                margin-bottom: ${list.space_after_pt ?? 2}pt;
                padding-left: ${list.indent_hanging_pt ?? 18}pt;
                text-indent: -${list.indent_hanging_pt ?? 18}pt;
            }
            li::before {
                content: "${String(bulletChar).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";
                display: inline-block;
                width: ${list.indent_hanging_pt ?? 18}pt;
                text-indent: 0;
            }
            .skills-line { margin: 0 0 ${spec.body?.space_after_pt ?? 2}pt 0; }
        `;

        // Build the contact line from the visible contact_fields, in
        // the order the user dragged them into. Separator is the
        // user-picked contact_separator from the spec; fall back to
        // '|' to match the legacy default.
        const visibleContacts = spec.contact_fields.filter(f => f.visible);
        const sampleValues = {
            city_state: 'Round Rock, TX',
            email: 'name@example.com',
            phone: '+1 555 0100',
            linkedin_url: 'linkedin.com/in/sample',
            github_url: 'github.com/sample'
        };
        const contactSep = (typeof spec.contact_separator === 'string'
            && /^[|•,\-·]$/.test(spec.contact_separator))
            ? spec.contact_separator
            : '|';
        const contactPieces = visibleContacts.map((f) => {
            const val = sampleValues[f.source] || f.label;
            return `<span>${escapeHtml(val)}</span>`;
        }).join(' ' + escapeHtml(contactSep) + ' ');

        const sampleJobs = [
            { title: 'Senior Full Stack Engineer', company: 'Frontdoor', location: 'Remote, US', dates: '09/2022 - Present', summary: 'Owned the Frontdoor real-estate financial platform end-to-end for three years, leading architecture, on-call, and a team of four engineers across AWS, Postgres, and Python services.', bullets: [
                'Architected multi-region active/active infrastructure on AWS.',
                'Built fraud detection integration layer connecting ML models to the transaction pipeline.'
            ] },
            { title: 'Full Stack Developer', company: 'ZenBusiness', location: 'Remote, US', dates: '01/2021 - 11/2022', summary: 'Shipped the business-formation platform serving 500K+ entrepreneurs across LLC, corporation, and trademark workflows.', bullets: [
                'Developed full-stack features for business formation platform.',
                'Implemented Kafka-based event streaming for asynchronous order processing.'
            ] }
        ];

        const renderJob = (j) => buildPreviewJob(j, spec.experience_row || {});

        const blockContent = (id) => {
            if (id === 'summary') {
                return `<p><strong>Senior Full Stack Engineer</strong> with <strong>8 years</strong> owning production web services end to end — from stakeholder work through on call. Most recent focus is real-time pipelines and developer tooling on AWS and Postgres.</p>`;
            }
            if (id === 'skills') {
                return `
                    <p class="skills-line"><strong>Languages:</strong> Python, TypeScript, Go, SQL</p>
                    <p class="skills-line"><strong>Frameworks:</strong> React, Node.js, FastAPI, Django</p>
                    <p class="skills-line"><strong>Infra:</strong> AWS, Docker, Kubernetes, Terraform</p>
                    <p class="skills-line"><strong>Data:</strong> PostgreSQL, Kafka, Redis</p>`;
            }
            if (id === 'experience') return sampleJobs.map(renderJob).join('');
            if (id === 'education') {
                return `<p><strong>Bachelor of Science in Computer Science | University of North Texas | 2014 - 2018</strong></p>`;
            }
            return '';
        };

        const html = `<html><head><style>${styles}</style></head><body>
            <h1>Sample Candidate</h1>
            <p class="contact">${contactPieces}</p>
            ${order.map(id => `<h2>${escapeHtml(blockLabels[id] || id)}</h2>${blockContent(id)}`).join('\n')}
        </body></html>`;
        setPreviewHtml(html);
    }, [spec]);

    if (loading || !spec) {
        return <PageLoader message="Loading template builder..." />;
    }

    return (
        <AppPage
            icon={Type}
            title="Resume Template Builder"
            description="Organize layout and typography by category. Preview updates live on the right."
        >
            <div className="space-y-4">
            <PageCommandBar
                search={(
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white/80">Template editor</p>
                        <p className="truncate text-xs text-white/40">
                            <Link to="/user/generate" className="inline-flex items-center text-primary hover:underline">
                                <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to Resume Generator
                            </Link>
                        </p>
                    </div>
                )}
                actions={(
                    <>
                        <Button variant="outline" size="sm" className="h-10" onClick={duplicate} disabled={!currentId || saving}>
                            <Copy className="h-4 w-4" />
                            <span className="hidden sm:inline">Duplicate</span>
                        </Button>
                        <Button variant="outline" size="sm" className="h-10" onClick={remove} disabled={!currentId || saving}>
                            <Trash2 className="h-4 w-4" />
                            <span className="hidden sm:inline">Delete</span>
                        </Button>
                        <Button size="sm" className="h-10" onClick={save} disabled={saving}>
                            <Save className="h-4 w-4" />
                            {saving ? 'Saving…' : 'Save'}
                        </Button>
                    </>
                )}
            />
            <div className="space-y-4">
            <Card>
                <CardContent className="flex flex-wrap items-center gap-2 pt-4">
                    <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Templates</span>
                    <Link to="/user/templates/new">
                        <Button variant="outline" size="sm">
                            <Plus className="mr-1 h-4 w-4" /> New
                        </Button>
                    </Link>
                    {library.map((t) => (
                        <Link key={t.id} to={`/user/templates/${t.id}`}>
                            <Button
                                variant={String(currentId) === String(t.id) ? 'default' : 'outline'}
                                size="sm"
                            >
                                {t.name}
                                {t.is_default ? <span className="ml-1 text-xs opacity-70">· default</span> : null}
                            </Button>
                        </Link>
                    ))}
                </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card className="min-w-0">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Settings</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Tabs defaultValue="general" className="w-full">
                            <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
                                {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
                                    <TabsTrigger key={id} value={id} className="gap-1.5 text-xs sm:text-sm">
                                        <Icon className="h-3.5 w-3.5 shrink-0" />
                                        {label}
                                    </TabsTrigger>
                                ))}
                            </TabsList>

                            <TabsContent value="general" className="space-y-4 focus-visible:ring-0">
                                <SettingsGroup title="Style presets" hint="One-click packs like other resume generators. You can fine-tune after applying.">
                                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                        {STYLE_PRESETS.map((preset) => (
                                            <button
                                                key={preset.id}
                                                type="button"
                                                onClick={() => applyPreset(preset)}
                                                className="rounded-lg border border-border bg-background px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
                                            >
                                                <div className="text-sm font-medium">{preset.label}</div>
                                                <div className="text-xs text-muted-foreground">{preset.hint}</div>
                                            </button>
                                        ))}
                                    </div>
                                </SettingsGroup>

                                <SettingsGroup title="Template details" hint="Name and when this template is preferred.">
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <div>
                                            <Label>Name</Label>
                                            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Template" />
                                        </div>
                                        <div>
                                            <Label>Description</Label>
                                            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
                                        </div>
                                    </div>
                                    <label className="flex items-start gap-3 text-sm">
                                        <input
                                            type="checkbox"
                                            checked={isDefault}
                                            onChange={(e) => setIsDefault(e.target.checked)}
                                            className="mt-1 h-4 w-4"
                                        />
                                        <div>
                                            <div className="font-medium">Set as my default template</div>
                                            <div className="text-xs text-muted-foreground">
                                                Used when a profile does not have another template assigned.
                                            </div>
                                        </div>
                                    </label>
                                </SettingsGroup>

                                {adminTemplates.length > 0 && (
                                    <SettingsGroup title="Admin templates" hint="Read-only reference. Assign these from the candidate profile.">
                                        <div className="flex flex-wrap gap-2">
                        {adminTemplates.map((t) => (
                            <Button
                                key={t.id}
                                variant="outline"
                                size="sm"
                                disabled
                                                    title="Admin-uploaded templates are read-only here."
                            >
                                {t.name}
                                {t.is_default ? <span className="ml-1 text-xs opacity-70">· default</span> : null}
                            </Button>
                        ))}
                                        </div>
                                    </SettingsGroup>
                                )}
                            </TabsContent>

                            <TabsContent value="header" className="space-y-4 focus-visible:ring-0">
                                <SettingsGroup title="Name (h1)" hint="Candidate name at the top of the resume.">
                                <HeadingControls
                                    rank={1}
                                    value={spec.name}
                                    onChange={updateNameSlot}
                                    allowedFonts={allowedFonts}
                                />
                                </SettingsGroup>

                                <SettingsGroup title="Contact line style" hint="Font and alignment for the contact row.">
                                <HeadingControls
                                    rank={2}
                                    value={spec.contact}
                                    onChange={updateContactSlot}
                                    allowedFonts={allowedFonts}
                                />
                                </SettingsGroup>

                                <SettingsGroup title="Contact fields" hint="Drag to reorder. Hide fields you do not want on the line.">
                                    <div>
                                        <Label className="text-xs uppercase tracking-wide text-muted-foreground">Separator</Label>
                                <SelectField
                                    value={spec.contact_separator || '|'}
                                    onChange={(v) => setSpec((s) => ({ ...s, contact_separator: v }))}
                                    options={[
                                                { value: '|', label: '|  (pipe)' },
                                                { value: '•', label: '•  (bullet)' },
                                                { value: ',', label: ',  (comma)' },
                                                { value: '-', label: '-  (dash)' },
                                                { value: '·', label: '·  (middle dot)' }
                                            ]}
                                        />
                            </div>
                            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onContactsDragEnd}>
                                <SortableContext items={spec.contact_fields.map(f => f.id)} strategy={verticalListSortingStrategy}>
                                    <div className="space-y-2">
                                        {spec.contact_fields.map((f) => (
                                            <SortableItem key={f.id} id={f.id}>
                                                <ContactFieldControls
                                                    field={f}
                                                    onChange={(patch) => updateContactField(f.id, patch)}
                                                />
                                            </SortableItem>
                                        ))}
                                    </div>
                                </SortableContext>
                            </DndContext>
                                </SettingsGroup>
                            </TabsContent>

                            <TabsContent value="sections" className="space-y-4 focus-visible:ring-0">
                                <SettingsGroup title="Section order" hint="Top-to-bottom order in the generated resume. Uncheck to hide.">
                            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onBlocksDragEnd}>
                                <SortableContext items={spec.blocks.map(b => b.id)} strategy={verticalListSortingStrategy}>
                                    <div className="space-y-2">
                                        {spec.blocks.map((b) => (
                                            <SortableItem key={b.id} id={b.id}>
                                                <BlockControls
                                                    block={b}
                                                    onChange={(patch) => updateBlock(b.id, patch)}
                                                    allowedFonts={allowedFonts}
                                                />
                                            </SortableItem>
                                        ))}
                                    </div>
                                </SortableContext>
                            </DndContext>
                                </SettingsGroup>

                                <SettingsGroup title="Heading labels" hint="Rename section titles. Leave blank to keep the AI label.">
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        {[
                                            { key: 'summary',    label: 'Summary',         placeholder: 'e.g. Professional Summary' },
                                            { key: 'skills',     label: 'Core Skills',     placeholder: 'e.g. Technical Skills' },
                                    { key: 'experience', label: 'Work Experience', placeholder: 'e.g. Career History' },
                                            { key: 'education',  label: 'Education',       placeholder: 'e.g. Academic Background' }
                                ].map(({ key, label, placeholder }) => (
                                    <div key={key}>
                                                <Label className="text-xs text-muted-foreground">{label}</Label>
                                        <Input
                                            value={spec.section_labels?.[key] || ''}
                                            placeholder={placeholder}
                                            onChange={(e) => updateSectionLabel(key, e.target.value)}
                                        />
                                    </div>
                                ))}
                            </div>
                                </SettingsGroup>

                                <SettingsGroup title="Section heading style (h2)" hint="Font, spacing, and underline bar under each section title.">
                                    <HeadingControls
                                        rank={2}
                                        value={spec.heading?.['2'] || {}}
                                        onChange={(patch) => updateHeading(2, patch)}
                                        allowedFonts={allowedFonts}
                                    />
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                        <div>
                                            <Label>Space before</Label>
                                            <SelectField
                                                value={String(spec.heading?.['2']?.space_before_pt ?? 10)}
                                                onChange={(v) => updateHeading(2, { space_before_pt: Number(v) })}
                                                options={SPACE_PT_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Space after</Label>
                                            <SelectField
                                                value={String(spec.heading?.['2']?.space_after_pt ?? 3)}
                                                onChange={(v) => updateHeading(2, { space_after_pt: Number(v) })}
                                                options={SPACE_PT_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Underline bar</Label>
                                            <SelectField
                                                value={spec.heading?.['2']?.border_bottom ? 'on' : 'off'}
                                                onChange={(v) => updateHeading(2, {
                                                    border_bottom: v === 'on'
                                                        ? (spec.heading?.['2']?.border_bottom || {
                                                            style: 'single',
                                                            size_pt: 0.75,
                                                            color: '000000',
                                                            space_pt: 1
                                                        })
                                                        : null
                                                })}
                                                options={[
                                                    { value: 'on', label: 'Show bar' },
                                                    { value: 'off', label: 'No bar' }
                                                ]}
                                            />
                                        </div>
                                    </div>
                                    {spec.heading?.['2']?.border_bottom ? (
                                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                            <div>
                                                <Label>Bar thickness</Label>
                                                <SelectField
                                                    value={String(spec.heading['2'].border_bottom.size_pt || 0.75)}
                                                    onChange={(v) => updateHeading(2, {
                                                        border_bottom: {
                                                            ...spec.heading['2'].border_bottom,
                                                            size_pt: Number(v)
                                                        }
                                                    })}
                                                    options={BORDER_SIZE_OPTIONS}
                                                />
                                            </div>
                                            <div>
                                                <Label>Bar color</Label>
                                                <SelectField
                                                    value={spec.heading['2'].border_bottom.color || '000000'}
                                                    onChange={(v) => updateHeading(2, {
                                                        border_bottom: {
                                                            ...spec.heading['2'].border_bottom,
                                                            color: v
                                                        }
                                                    })}
                                                    options={[
                                                        { value: '000000', label: 'Black' },
                                                        { value: '333333', label: 'Dark gray' },
                                                        { value: '666666', label: 'Gray' },
                                                        { value: '1F4E79', label: 'Navy' },
                                                        { value: '2E7D32', label: 'Green' },
                                                        { value: 'B71C1C', label: 'Red' }
                                                    ]}
                                                />
                                            </div>
                                        </div>
                                    ) : null}
                                </SettingsGroup>
                            </TabsContent>

                            <TabsContent value="experience" className="space-y-4 focus-visible:ring-0">
                                <SettingsGroup title="Job title style (h3)" hint="Typography for each role heading.">
                                    <HeadingControls
                                        rank={3}
                                        value={spec.heading?.['3'] || {}}
                                        onChange={(patch) => updateHeading(3, patch)}
                                        allowedFonts={allowedFonts}
                                    />
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <div>
                                            <Label>Space before</Label>
                                            <SelectField
                                                value={String(spec.heading?.['3']?.space_before_pt ?? 6)}
                                                onChange={(v) => updateHeading(3, { space_before_pt: Number(v) })}
                                                options={SPACE_PT_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Space after</Label>
                                            <SelectField
                                                value={String(spec.heading?.['3']?.space_after_pt ?? 2)}
                                                onChange={(v) => updateHeading(3, { space_after_pt: Number(v) })}
                                                options={SPACE_PT_OPTIONS}
                                            />
                                        </div>
                                    </div>
                                </SettingsGroup>

                                <SettingsGroup title="Experience row layout" hint="How title, company, location, and dates are arranged.">
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div>
                                    <Label>Layout</Label>
                                    <SelectField
                                        value={spec.experience_row?.layout || 'two_column'}
                                        onChange={(v) => updateExperienceRow({ layout: v })}
                                        options={[
                                            { value: 'two_column', label: 'Two columns (title | dates)' },
                                            { value: 'stacked',    label: 'Stacked (one line per row)' }
                                        ]}
                                    />
                                </div>
                                <div>
                                    <Label>Separator</Label>
                                    <SelectField
                                        value={spec.experience_row?.separator || '|'}
                                        onChange={(v) => updateExperienceRow({ separator: v })}
                                        options={[
                                            { value: '|', label: '|  (pipe)' },
                                            { value: '•', label: '•  (bullet)' },
                                                    { value: ',', label: ',  (comma)' },
                                                    { value: '-', label: '-  (dash)' },
                                                    { value: '·', label: '·  (middle dot)' }
                                        ]}
                                    />
                                </div>
                            </div>
                                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                <div>
                                    <Label>Title align</Label>
                                    <SelectField
                                        value={spec.experience_row?.title_align || 'left'}
                                        onChange={(v) => updateExperienceRow({ title_align: v })}
                                                options={ALIGN_LR_OPTIONS}
                                    />
                                </div>
                                <div>
                                    <Label>Company align</Label>
                                    <SelectField
                                        value={spec.experience_row?.company_align || 'left'}
                                        onChange={(v) => updateExperienceRow({ company_align: v })}
                                                options={ALIGN_LR_OPTIONS}
                                    />
                                </div>
                                <div>
                                    <Label>Location align</Label>
                                    <SelectField
                                        value={spec.experience_row?.location_align || 'left'}
                                        onChange={(v) => updateExperienceRow({ location_align: v })}
                                                options={ALIGN_LR_OPTIONS}
                                    />
                                </div>
                                <div>
                                    <Label>Dates align</Label>
                                    <SelectField
                                        value={spec.experience_row?.dates_align || 'right'}
                                        onChange={(v) => updateExperienceRow({ dates_align: v })}
                                                options={ALIGN_LR_OPTIONS}
                                    />
                                </div>
                            </div>
                            <div>
                                        <Label className="mb-2 block text-xs text-muted-foreground">Italic</Label>
                                        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                                    {[
                                                ['title_italic', 'Title'],
                                                ['company_italic', 'Company'],
                                        ['location_italic', 'Location'],
                                                ['dates_italic', 'Dates']
                                    ].map(([key, label]) => (
                                        <label key={key} className="flex items-center gap-2">
                                            <input
                                                type="checkbox"
                                                checked={!!spec.experience_row?.[key]}
                                                onChange={(e) => updateExperienceRow({ [key]: e.target.checked })}
                                                className="h-4 w-4"
                                            />
                                            <span>{label}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                            <div>
                                        <Label className="mb-2 block text-xs text-muted-foreground">Wraps & visibility</Label>
                                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                                            {[
                                                ['wrap_title_company', 'Company on next line', true],
                                                ['wrap_company_location', 'Location on next line', true],
                                                ['show_company', 'Show company', false],
                                                ['show_location', 'Show location', false]
                                            ].map(([key, label, strictTrue]) => (
                                                <label key={key} className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                                        checked={strictTrue
                                                            ? spec.experience_row?.[key] === true
                                                            : spec.experience_row?.[key] !== false}
                                                        onChange={(e) => updateExperienceRow({ [key]: e.target.checked })}
                                            className="h-4 w-4"
                                        />
                                                    {label}
                                    </label>
                                            ))}
                                </div>
                            </div>
                                    <label className="flex items-start gap-3 border-t pt-3 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={spec.experience_row?.work_summary === true}
                                        onChange={(e) => updateExperienceRow({ work_summary: e.target.checked })}
                                        className="mt-1 h-4 w-4"
                                    />
                                    <div>
                                        <div className="font-medium">Per-job work summary</div>
                                            <div className="text-xs text-muted-foreground">
                                                One italic sentence per job above the bullet list.
                                        </div>
                                    </div>
                                </label>
                                    <div>
                                        <Label>Space between jobs</Label>
                                        <SelectField
                                            value={String(spec.experience_row?.job_gap_pt ?? 6)}
                                            onChange={(v) => updateExperienceRow({ job_gap_pt: Number(v) })}
                                            options={SPACE_PT_OPTIONS}
                                        />
                            </div>
                                </SettingsGroup>
                            </TabsContent>

                            <TabsContent value="typography" className="space-y-4 focus-visible:ring-0">
                                <SettingsGroup
                                    title="Body text"
                                    hint="Preview font for the builder. Add several fonts to the pool — generate picks one at random when Font is set to Random."
                                >
                                    <div className="space-y-3">
                                <div>
                                            <Label>Preview / default font</Label>
                                    <SelectField
                                        value={spec.body?.font || 'Arial'}
                                        onChange={(v) => updateBody({ font: v })}
                                                options={(allowedFonts.length ? allowedFonts : FALLBACK_FONTS).map(f => ({ value: f, label: f }))}
                                    />
                                </div>
                                        <div>
                                            <Label>Font pool (random on generate)</Label>
                                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                                                {(Array.isArray(spec.body?.font_pool) && spec.body.font_pool.length
                                                    ? spec.body.font_pool
                                                    : [spec.body?.font || 'Arial']
                                                ).map((f) => (
                                                    <button
                                                        key={f}
                                                        type="button"
                                                        className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs hover:border-destructive/50"
                                                        style={{ fontFamily: f }}
                                                        title="Remove from pool"
                                                        onClick={() => removeFontFromPool(f)}
                                                    >
                                                        {f}
                                                        <span className="text-muted-foreground">×</span>
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="mt-2">
                                                <SelectField
                                                    value=""
                                                    onChange={(v) => addFontToPool(v)}
                                                    options={[
                                                        { value: '', label: 'Add a font…' },
                                                        ...(allowedFonts.length ? allowedFonts : FALLBACK_FONTS)
                                                            .filter((f) => !(spec.body?.font_pool || []).includes(f))
                                                            .map((f) => ({ value: f, label: f }))
                                                    ]}
                                                />
                                            </div>
                                            <p className="mt-1.5 text-xs text-muted-foreground">
                                                Click a chip to remove it. Resume Generator defaults to random from this list.
                                            </p>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <div>
                                    <Label>Size</Label>
                                    <SelectField
                                        value={String(spec.body?.size_half_pt || 20)}
                                        onChange={(v) => updateBody({ size_half_pt: Number(v) })}
                                        options={FONT_SIZE_HALF_PT.map(s => ({ value: String(s), label: `${s / 2}pt` }))}
                                    />
                                </div>
                                <div>
                                    <Label>Align</Label>
                                    <SelectField
                                        value={spec.body?.align || 'left'}
                                        onChange={(v) => updateBody({ align: v })}
                                        options={ALIGN_OPTIONS}
                                    />
                                </div>
                                        <div>
                                            <Label>Line spacing</Label>
                                            <SelectField
                                                value={String(spec.body?.line_spacing || 1.35)}
                                                onChange={(v) => updateBody({ line_spacing: Number(v) })}
                                                options={LINE_SPACING_OPTIONS}
                                            />
                            </div>
                                    </div>
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <div>
                                            <Label>Space after paragraphs</Label>
                                            <SelectField
                                                value={String(spec.body?.space_after_pt ?? 2)}
                                                onChange={(v) => updateBody({ space_after_pt: Number(v) })}
                                                options={SPACE_PT_OPTIONS}
                                            />
                                        </div>
                                    </div>
                                </SettingsGroup>

                                <SettingsGroup title="Bullet lists" hint="Experience, education, and other list items.">
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <div>
                                            <Label>Bullet character</Label>
                                            <SelectField
                                                value={spec.list?.bullet_char || '•'}
                                                onChange={(v) => updateList({ bullet_char: v })}
                                                options={BULLET_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Space after each item</Label>
                                            <SelectField
                                                value={String(spec.list?.space_after_pt ?? 2)}
                                                onChange={(v) => updateList({ space_after_pt: Number(v) })}
                                                options={SPACE_PT_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Left indent</Label>
                                            <SelectField
                                                value={String(spec.list?.indent_left_pt ?? 18)}
                                                onChange={(v) => updateList({ indent_left_pt: Number(v) })}
                                                options={INDENT_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Hanging indent</Label>
                                            <SelectField
                                                value={String(spec.list?.indent_hanging_pt ?? 18)}
                                                onChange={(v) => updateList({ indent_hanging_pt: Number(v) })}
                                                options={INDENT_OPTIONS}
                                            />
                                        </div>
                                    </div>
                                </SettingsGroup>
                            </TabsContent>

                            <TabsContent value="colors" className="space-y-4 focus-visible:ring-0">
                                <SettingsGroup title="Theme accent" hint="Applies to name, section headings, job titles, and the underline bar.">
                                    <SelectField
                                        value={colorSelectValue(spec.theme?.accent_color)}
                                        onChange={applyAccentColor}
                                        options={COLOR_OPTIONS}
                                    />
                                </SettingsGroup>
                                <SettingsGroup title="Per-element colors" hint="Override individual parts without changing the whole theme.">
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <div>
                                            <Label>Name</Label>
                                            <SelectField
                                                value={colorSelectValue(spec.name?.color)}
                                                onChange={(v) => updateNameSlot({ color: colorFromSelect(v) })}
                                                options={COLOR_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Contact line</Label>
                                            <SelectField
                                                value={colorSelectValue(spec.contact?.color)}
                                                onChange={(v) => updateContactSlot({ color: colorFromSelect(v) })}
                                                options={COLOR_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Section headings</Label>
                                            <SelectField
                                                value={colorSelectValue(spec.heading?.['2']?.color)}
                                                onChange={(v) => updateHeading(2, { color: colorFromSelect(v) })}
                                                options={COLOR_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Job titles</Label>
                                            <SelectField
                                                value={colorSelectValue(spec.heading?.['3']?.color)}
                                                onChange={(v) => updateHeading(3, { color: colorFromSelect(v) })}
                                                options={COLOR_OPTIONS}
                                            />
                                        </div>
                                        <div>
                                            <Label>Body text</Label>
                                            <SelectField
                                                value={colorSelectValue(spec.body?.color)}
                                                onChange={(v) => updateBody({ color: colorFromSelect(v) })}
                                                options={COLOR_OPTIONS}
                                            />
                                        </div>
                                    </div>
                                </SettingsGroup>
                            </TabsContent>

                            <TabsContent value="page" className="space-y-4 focus-visible:ring-0">
                                <SettingsGroup title="Paper size" hint="US Letter or A4 for international applications.">
                                    <SelectField
                                        value={spec.page?.paper_size || 'letter'}
                                        onChange={(v) => updatePage({ paper_size: v })}
                                        options={PAPER_OPTIONS}
                                    />
                                </SettingsGroup>
                                <SettingsGroup title="Page margins" hint="Applied to DOCX, PDF, and the live preview.">
                                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                        {[
                                            ['margin_top_pt', 'Top'],
                                            ['margin_bottom_pt', 'Bottom'],
                                            ['margin_left_pt', 'Left'],
                                            ['margin_right_pt', 'Right']
                                        ].map(([key, label]) => (
                                            <div key={key}>
                                                <Label>{label}</Label>
                                                <SelectField
                                                    value={String(spec.page?.[key] ?? 36)}
                                                    onChange={(v) => updatePage({ [key]: Number(v) })}
                                                    options={MARGIN_OPTIONS}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </SettingsGroup>
                            </TabsContent>
                        </Tabs>
                        </CardContent>
                    </Card>

                <div className="lg:sticky lg:top-4 lg:self-start">
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center text-base">
                                <Eye className="mr-1 h-4 w-4" /> Live preview
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="rounded border bg-white p-4 text-sm shadow-inner" style={{ minHeight: 600 }}>
                                <iframe
                                    title="Template preview"
                                    srcDoc={previewHtml}
                                    key={previewHtml.length + ':' + (spec?.body?.font || '')}
                                    className="w-full"
                                    style={{ height: 800, border: 0 }}
                                />
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                                Preview updates as you edit. Save to lock changes.
                            </p>
                        </CardContent>
                    </Card>
                </div>
            </div>

            {toast && (
                <div className={cn(
                    'fixed bottom-6 right-6 flex items-center gap-2 rounded-md px-4 py-2 text-sm shadow-lg',
                    toast.kind === 'ok' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
                )}>
                    {toast.kind === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : null}
                    <span>{toast.text}</span>
                </div>
            )}
            </div>
            </div>
        </AppPage>
    );
}
