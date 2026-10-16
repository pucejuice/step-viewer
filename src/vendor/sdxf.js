// Vendored from github.com/pucejuice/sdxfjs (sdxf.js, sha256 82ebdab65902).
// Do not edit here: change sdxfjs and re-run  node scripts/sync-sdxf.mjs
/**
 * SDXF JavaScript Translation — Complete & AC1015-Compliant
 *
 * Fixes applied:
 * 1. Group code 330 (owner handle) on all entities — required by AC1015
 * 2. AcDb subclass markers (group 100) on all entities
 * 3. *Model_Space / *Paper_Space blocks in BLOCKS section
 * 4. BLOCK_RECORD, APPID, DIMSTYLE tables
 * 5. OBJECTS section
 * 6. $HANDSEED in HEADER
 * 7. Unique handles per entity (group 5)
 * 8. Collection.toString() filters empty strings — prevents null object ID
 * 9. LwPolyLine: group 90 (vertex count), group 70 (flag), 2D-only vertices,
 *    no trailing bare group-code-0, degenerate guard (< 2 points returns '')
 * 10. Text: empty string guard
 * 11. brTable: fixed blank line bug (NL+content → count+NL+content)
 * 12. $HANDSEED written after all handles are allocated (was fixed at FFFF,
 *     which is invalid once a drawing holds more than 65 534 objects)
 * 13. LineType writes its dash elements (group 49/74) and pattern length, so
 *     dashed linetypes such as HIDDEN or CENTER work
 * 14. Entity lineTypeScale is written (group 48)
 * 15. Drawing options insunits ($INSUNITS, 4 = mm) and ltscale ($LTSCALE)
 * 16. Works as a classic <script>, and as a CommonJS module (module.exports)
 */

const NL = String.fromCharCode(10);

// ── Handle counter — unique hex handle per entity, reset per Drawing ──────────
let _dxfHandle = 1;
function _nextHandle() { return (_dxfHandle++).toString(16).toUpperCase(); }
function _resetHandles() { _dxfHandle = 1; }

// ── Pre-allocate a block of handles at start so referenced objects have
//    known handles before any entities are written ────────────────────────────
let _H_TABLES, _H_BLOCKTABLE, _H_MODEL_BTR, _H_PAPER_BTR;
let _H_LTYPE_TBL, _H_LAYER_TBL, _H_STYLE_TBL, _H_VIEW_TBL;
let _H_UCS_TBL, _H_APPID_TBL, _H_DIM_TBL;
function _preAllocHandles() {
  _H_TABLES      = _nextHandle();
  _H_BLOCKTABLE  = _nextHandle();
  _H_MODEL_BTR   = _nextHandle(); // *Model_Space block table record — owner of all model entities
  _H_PAPER_BTR   = _nextHandle();
  _H_LTYPE_TBL   = _nextHandle();
  _H_LAYER_TBL   = _nextHandle();
  _H_STYLE_TBL   = _nextHandle();
  _H_VIEW_TBL    = _nextHandle();
  _H_UCS_TBL     = _nextHandle();
  _H_APPID_TBL   = _nextHandle();
  _H_DIM_TBL     = _nextHandle();
}

function _point(x, index = 0) { return x.map((val, i) => `${(i + 1) * 10 + index}${NL}${val}`).join(NL); }
function _points(p) { return p.map((pt, i) => _point(pt, i)); }
function calculate_end_point(start_point, angle_degrees, length) {
  const [x_start, y_start] = start_point;
  const angle_radians = angle_degrees * (Math.PI / 180);
  return [x_start + length * Math.cos(angle_radians), y_start + length * Math.sin(angle_radians)];
}

class Entity {
  constructor({ color = 256, extrusion = null, layer = '0', lineType = null, lineTypeScale = null, lineWeight = null, thickness = null, parent = null } = {}) {
    this.color = color; this.extrusion = extrusion; this.layer = layer; this.lineType = lineType;
    this.lineTypeScale = lineTypeScale; this.lineWeight = lineWeight; this.thickness = thickness; this.parent = parent;
  }
  _common() {
    const parent = this.parent || this;
    // Group 5: unique handle. Group 330: owner = *Model_Space block table record.
    const lines = ['5', _nextHandle(), '330', _H_MODEL_BTR, '100', 'AcDbEntity', '8', parent.layer];
    if (parent.lineType !== null) lines.push('6', parent.lineType);
    if (parent.lineTypeScale !== null) lines.push('48', parent.lineTypeScale);
    if (parent.lineWeight !== null) lines.push('370', parent.lineWeight);
    if (parent.color !== null && parent.color !== 256) lines.push('62', parent.color);
    return lines.join(NL);
  }
}

class Collection {
  constructor(entities = []) { this.entities = [...entities]; }
  append(entity) { this.entities.push(entity); }
  // Filter empty/whitespace strings — prevents blank lines inside sections
  // that parse as group code 0 with null value ("Null object ID").
  toString() { return this.entities.map(e => e.toString()).filter(s => s && s.trim()).join(NL); }
}

// ── Table entry classes ───────────────────────────────────────────────────────
class Layer {
  constructor({ name = 'pydxf', color = 7, lineType = 'continuous', flag = 64 } = {}) {
    this.name = name.toUpperCase(); this.color = color; this.lineType = lineType; this.flag = flag;
  }
  toString() {
    return ['0','LAYER','5',_nextHandle(),'330',_H_LAYER_TBL,
            '100','AcDbSymbolTableRecord','100','AcDbLayerTableRecord',
            '2',this.name,'70',this.flag,'62',this.color,'6',this.lineType].join(NL);
  }
}
class LineType {
  // elements: dash lengths, positive = dash, negative = gap, 0 = dot,
  // e.g. HIDDEN: [6.35, -3.175]
  constructor({ name = 'continuous', description = 'Solid line', elements = [], flag = 64 } = {}) {
    this.name = name.toUpperCase(); this.description = description; this.elements = [...elements]; this.flag = flag;
  }
  toString() {
    const total = this.elements.reduce((s, e) => s + Math.abs(e), 0);
    const lines = ['0','LTYPE','5',_nextHandle(),'330',_H_LTYPE_TBL,
                   '100','AcDbSymbolTableRecord','100','AcDbLinetypeTableRecord',
                   '2',this.name,'70',this.flag,'3',this.description,'72','65','73',this.elements.length,'40',total];
    for (const e of this.elements) lines.push('49', e, '74', '0');
    return lines.join(NL);
  }
}
class Style {
  constructor({ name = 'standard', flag = 0, height = 0, widthFactor = 40, obliqueAngle = 50, mirror = 0, lastHeight = 1, font = 'arial.ttf', bigFont = '' } = {}) {
    this.name = name.toUpperCase(); this.flag = flag; this.height = height; this.widthFactor = widthFactor;
    this.obliqueAngle = obliqueAngle; this.mirror = mirror; this.lastHeight = lastHeight;
    this.font = font.toUpperCase(); this.bigFont = bigFont.toUpperCase();
  }
  toString() {
    return ['0','STYLE','5',_nextHandle(),'330',_H_STYLE_TBL,
            '100','AcDbSymbolTableRecord','100','AcDbTextStyleTableRecord',
            '2',this.name,'70',this.flag,'40',this.height,'41',this.widthFactor,
            '50',this.obliqueAngle,'71',this.mirror,'42',this.lastHeight,'3',this.font,'4',this.bigFont].join(NL);
  }
}

// ── Block / Insert ────────────────────────────────────────────────────────────
class Block extends Collection {
  constructor(name, { layer = '0', flag = 0, base = [0, 0, 0], entities = [] } = {}) {
    super(entities); this.name = name; this.layer = layer; this.flag = flag; this.base = base;
  }
  toString() {
    const upperName = this.name.toUpperCase();
    const body = super.toString();
    const parts = ['0','BLOCK','5',_nextHandle(),'330',_H_MODEL_BTR,
                   '100','AcDbEntity','8',this.layer,'100','AcDbBlockBegin',
                   '2',upperName,'70',this.flag,_point(this.base),'3',upperName,'1',''];
    if (body) parts.push(body);
    parts.push('0','ENDBLK','5',_nextHandle(),'330',_H_MODEL_BTR,'100','AcDbEntity','8',this.layer,'100','AcDbBlockEnd');
    return parts.join(NL);
  }
}

// ── Geometry entities ─────────────────────────────────────────────────────────
class Line extends Entity {
  constructor(points, commonOptions = {}) { super(commonOptions); this.points = points; }
  toString() { return ['0','LINE',this._common(),'100','AcDbLine',_points(this.points).join(NL)].join(NL); }
}
class LwPolyLine extends Entity {
  constructor(points, { flag = 0, width = null, elevation = null, bulge = null, bulges = null, ...commonOptions } = {}) {
    super(commonOptions); this.points = points; this.flag = flag; this.width = width;
    this.elevation = elevation; this.bulge = bulge; this.bulges = bulges;
  }
  toString() {
    if (!this.points || this.points.length < 2) return '';
    const lines = ['0','LWPOLYLINE',this._common(),'100','AcDbPolyline',
                   '90',this.points.length,'70',this.flag || 0];
    if (this.width !== null) lines.push('43', this.width);
    if (this.elevation !== null) lines.push('38', this.elevation);
    for (let idx = 0; idx < this.points.length; idx++) {
      const pt = this.points[idx];
      lines.push(`10${NL}${pt[0]}`, `20${NL}${pt[1]}`);
      if (this.bulges !== null && idx < this.bulges.length) lines.push('42', this.bulges[idx]);
      else if (this.bulge !== null) lines.push('42', this.bulge);
    }
    return lines.join(NL);
  }
}
class Circle extends Entity {
  constructor(center = [0,0,0], radius = 1, commonOptions = {}) { super(commonOptions); this.center = center; this.radius = radius; }
  toString() { return ['0','CIRCLE',this._common(),'100','AcDbCircle',_point(this.center),'40',this.radius].join(NL); }
}
class Arc extends Entity {
  constructor(center = [0,0,0], radius = 1, startAngle = 0, endAngle = 90, commonOptions = {}) {
    super(commonOptions); this.center = center; this.radius = radius; this.startAngle = startAngle; this.endAngle = endAngle;
  }
  toString() { return ['0','ARC',this._common(),'100','AcDbCircle',_point(this.center),'40',this.radius,'100','AcDbArc','50',this.startAngle,'51',this.endAngle].join(NL); }
}
class Point extends Entity {
  constructor(point = [0,0,0], commonOptions = {}) { super(commonOptions); this.point = point; }
  toString() { return ['0','POINT',this._common(),'100','AcDbPoint',_point(this.point)].join(NL); }
}
class Text extends Entity {
  constructor(text = '', point = [0,0,0], { height = 1, rotation = null, style = null, ...common } = {}) {
    super(common); this.text = text; this.point = point; this.height = height; this.rotation = rotation; this.style = style;
  }
  toString() {
    const t = String(this.text ?? '').trim();
    if (!t) return '';
    const lines = ['0','TEXT',this._common(),'100','AcDbText',_point(this.point),'40',this.height,'1',t];
    if (this.rotation !== null) lines.push('50', this.rotation);
    if (this.style !== null) lines.push('7', this.style);
    lines.push('100','AcDbText');  // second AcDbText subclass marker required by R2000
    return lines.join(NL);
  }
}
class Solid extends Entity {
  constructor(points = [], commonOptions = {}) { super(commonOptions); this.points = points; }
  toString() {
    const p = this.points;
    const rp = [p[0],p[1],p[3],p[2]];
    return ['0','SOLID',this._common(),'100','AcDbTrace',_points(rp).join(NL)].join(NL);
  }
}

// ── Main Drawing class ────────────────────────────────────────────────────────
class Drawing extends Collection {
  constructor({ insbase = [0,0,0], extmin = [0,0], extmax = [0,0],
                layers = [new Layer()], linetypes = [new LineType()], styles = [new Style()],
                views = [], blocks = [], entities = [], insunits = null, ltscale = null } = {}) {
    super(entities);
    this.insbase = insbase; this.extmin = extmin; this.extmax = extmax;
    this.insunits = insunits; this.ltscale = ltscale;
    this.layers = [...layers]; this.linetypes = [...linetypes]; this.styles = [...styles];
    this.views = [...views]; this.blocks = [...blocks];
  }
  _section(name, items) {
    const f = (items || []).filter(s => s && s.trim());
    const x = f.length > 0 ? NL + f.join(NL) : '';
    return ['0','SECTION','2',name.toUpperCase()+x,'0','ENDSEC'].join(NL);
  }
  _table(name, handle, parentHandle, items) {
    const f = (items || []).filter(s => s && s.trim());
    const x = f.length > 0 ? NL + f.join(NL) : '';
    return ['0','TABLE','2',name.toUpperCase(),'5',handle,'330',parentHandle,
            '100','AcDbSymbolTable','70',f.length+x,'0','ENDTAB'].join(NL);
  }
  toString() {
    _resetHandles();
    _preAllocHandles();

    // ── TABLES ──────────────────────────────────────────────────
    const brDefs = [
      ['0','BLOCK_RECORD','5',_nextHandle(),'330',_H_BLOCKTABLE,
       '100','AcDbSymbolTableRecord','100','AcDbBlockTableRecord',
       '2','*Model_Space','70','0','280','1','281','0'].join(NL),
      ['0','BLOCK_RECORD','5',_nextHandle(),'330',_H_BLOCKTABLE,
       '100','AcDbSymbolTableRecord','100','AcDbBlockTableRecord',
       '2','*Paper_Space','70','0','280','1','281','0'].join(NL),
    ];
    const brTable = ['0','TABLE','2','BLOCK_RECORD','5',_H_BLOCKTABLE,'330',_H_TABLES,
                     '100','AcDbSymbolTable','70',
                     '2'+NL+brDefs.join(NL),   // count+content as one element — no leading blank line
                     '0','ENDTAB'].join(NL);

    const appidDef = ['0','APPID','5',_nextHandle(),'330',_H_APPID_TBL,
                      '100','AcDbSymbolTableRecord','100','AcDbRegAppTableRecord',
                      '2','ACAD','70','0'].join(NL);
    const dimDef   = ['0','DIMSTYLE','5',_nextHandle(),'330',_H_DIM_TBL,
                      '100','AcDbSymbolTableRecord','100','AcDbDimStyleTableRecord',
                      '2','Standard','70','0'].join(NL);

    const tables = this._section('tables', [
      this._table('LTYPE',    _H_LTYPE_TBL, _H_TABLES, this.linetypes.map(x => x.toString())),
      this._table('LAYER',    _H_LAYER_TBL, _H_TABLES, this.layers.map(x => x.toString())),
      this._table('STYLE',    _H_STYLE_TBL, _H_TABLES, this.styles.map(x => x.toString())),
      this._table('VIEW',     _H_VIEW_TBL,  _H_TABLES, this.views.map(x => x.toString())),
      this._table('UCS',      _H_UCS_TBL,   _H_TABLES, []),
      this._table('APPID',    _H_APPID_TBL, _H_TABLES, [appidDef]),
      this._table('DIMSTYLE', _H_DIM_TBL,   _H_TABLES, [dimDef]),
      brTable,
    ]);

    // ── BLOCKS — mandatory *Model_Space and *Paper_Space ─────────
    const modelBlock = [
      '0','BLOCK','5',_nextHandle(),'330',_H_MODEL_BTR,'100','AcDbEntity','8','0',
      '100','AcDbBlockBegin','2','*Model_Space','70','0',_point([0,0,0]),'3','*Model_Space','1','',
      '0','ENDBLK','5',_nextHandle(),'330',_H_MODEL_BTR,'100','AcDbEntity','8','0','100','AcDbBlockEnd',
    ].join(NL);
    const paperBlock = [
      '0','BLOCK','5',_nextHandle(),'330',_H_PAPER_BTR,'100','AcDbEntity','8','0',
      '100','AcDbBlockBegin','2','*Paper_Space','70','0',_point([0,0,0]),'3','*Paper_Space','1','',
      '0','ENDBLK','5',_nextHandle(),'330',_H_PAPER_BTR,'100','AcDbEntity','8','0','100','AcDbBlockEnd',
    ].join(NL);
    const userBlocks = this.blocks.map(x => x.toString()).filter(s => s && s.trim());
    const blocks = this._section('blocks', [modelBlock, paperBlock, ...userBlocks]);

    // ── ENTITIES ─────────────────────────────────────────────────
    const entities = this._section('entities', this.entities.map(x => x.toString()));

    // ── OBJECTS — required for AC1015 ────────────────────────────
    const objects = this._section('objects', []);

    // ── HEADER — written last so $HANDSEED is above every handle used ──
    const headerVars = [
      ['9','$ACADVER','1','AC1015'].join(NL),
      ['9','$HANDSEED','5',_nextHandle()].join(NL),
      ['9','$INSBASE',  _point(this.insbase)].join(NL),
      ['9','$EXTMIN',   _point(this.extmin)].join(NL),
      ['9','$EXTMAX',   _point(this.extmax)].join(NL),
    ];
    if (this.insunits !== null) headerVars.push(['9','$INSUNITS','70',this.insunits].join(NL));
    if (this.ltscale !== null) headerVars.push(['9','$LTSCALE','40',this.ltscale].join(NL));
    const header = this._section('header', headerVars);

    return [header, tables, blocks, entities, objects, '0', 'EOF', ''].join(NL);
  }
}

export { Drawing, Layer, LineType, Style, Block, Line, LwPolyLine, Circle, Arc, Point, Text, Solid, Collection, Entity, calculate_end_point };
