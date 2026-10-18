// Native OOXML PivotTable parts layered onto the existing SheetJS workbook.
// Source: Microsoft Open XML, Working with PivotTables. No external runtime.
const S='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P='http://schemas.openxmlformats.org/package/2006/relationships';
const xml=s=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`;
const esc=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const stringItem=v=>`<s v="${esc(v)}"/>`;
// Excel repairs the cache on open when a shared string is longer than 255 characters and the
// field is not flagged longText; the note column regularly exceeds that.
const longTextAttr=items=>items.some(v=>String(v).length>255)?' longText="1"':'';

export function addSessionPivot(XLSX, workbookBytes, { headers, records, sourceSheet, sourceRange, coaches, columns, summaryRange, rowFieldIndex = 3, columnFieldIndex = 11, dataFieldIndex = 7, dateFieldIndex, noteFieldIndex }) {
  if(headers.length<12 || [rowFieldIndex,columnFieldIndex,dataFieldIndex].some(i=>!Number.isInteger(i)||i<0||i>=headers.length)
    ||new Set([rowFieldIndex,columnFieldIndex,dataFieldIndex]).size!==3||records.some(row=>row.length!==headers.length)) throw new Error('SESSION_PIVOT_SOURCE_SCHEMA');
  const CFB=XLSX.CFB;
  const archive=CFB.read(new Uint8Array(workbookBytes),{type:'array'});
  const decoder=new TextDecoder(), encoder=new TextEncoder();
  const read=name=>{const file=CFB.find(archive,'/'+name);if(!file)throw new Error('SESSION_PIVOT_PART_MISSING');return decoder.decode(file.content);};
  const write=(name,text)=>CFB.utils.cfb_add(archive,'/'+name,encoder.encode(text));
  const values=headers.map((_,i)=> i===rowFieldIndex?[...coaches]:i===columnFieldIndex?[...columns]:[]);
  const maps=values.map(v=>new Map(v.map((x,i)=>[String(x),i])));
  const indexed=records.map(row=>headers.map((_,i)=>{
    const value=row[i];if(value===null||value===undefined||value==='')return null;
    const text=String(value);if(!maps[i].has(text)){maps[i].set(text,values[i].length);values[i].push(text);}return maps[i].get(text);
  }));
  // Blank cells must be a shared <m/> item referenced by index; inline <m/> records make Excel repair the cache.
  const blank=headers.map((_,i)=>indexed.some(r=>r[i]===null));
  const fields=headers.map((name,i)=>`<cacheField name="${esc(name)}"><sharedItems count="`+(values[i].length+(blank[i]?1:0))+`" containsString="`+(values[i].length?1:0)+`" containsBlank="`+(blank[i]?1:0)+'"'+longTextAttr(values[i])+'>'+`${values[i].map(stringItem).join('')}`+(blank[i]?'<m/>':'')+`</sharedItems></cacheField>`).join('');
  write('xl/pivotCache/pivotCacheDefinition1.xml',xml(`<pivotCacheDefinition xmlns="${S}" xmlns:r="${R}" r:id="rId1" refreshOnLoad="0" enableRefresh="1" recordCount="${records.length}" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3"><cacheSource type="worksheet"><worksheetSource ref="${esc(sourceRange)}" sheet="${esc(sourceSheet)}"/></cacheSource><cacheFields count="${headers.length}">${fields}</cacheFields></pivotCacheDefinition>`));
  write('xl/pivotCache/pivotCacheRecords1.xml',xml(`<pivotCacheRecords xmlns="${S}" count="${records.length}">${indexed.map(row=>`<r>${row.map((v,i)=>v===null?'<x v="'+values[i].length+'"/>':`<x v="${v}"/>`).join('')}</r>`).join('')}</pivotCacheRecords>`));
  const items=n=>`<items count="${n+1}">${Array.from({length:n},(_,i)=>`<item x="${i}"/>`).join('')}<item t="default"/></items>`;
  const pivotFields=headers.map((_,i)=>i===rowFieldIndex?`<pivotField axis="axisRow" showAll="0">${items(coaches.length)}</pivotField>`:i===columnFieldIndex?`<pivotField axis="axisCol" showAll="0">${items(columns.length)}</pivotField>`:i===dataFieldIndex?'<pivotField dataField="1" showAll="0"/>':'<pivotField showAll="0"/>').join('');
  const axisItems=n=>`${Array.from({length:n},(_,i)=>`<i><x v="${i}"/></i>`).join('')}<i t="grand"><x/></i>`;
  write('xl/pivotTables/pivotTable1.xml',xml(`<pivotTableDefinition xmlns="${S}" name="FR01CoefficientSummary" cacheId="0" dataCaption="數值" rowGrandTotals="1" colGrandTotals="1" updatedVersion="6" minRefreshableVersion="3" createdVersion="6" useAutoFormatting="1"><location ref="${esc(summaryRange)}" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/><pivotFields count="${headers.length}">${pivotFields}</pivotFields><rowFields count="1"><field x="${rowFieldIndex}"/></rowFields><rowItems count="${coaches.length+1}">${axisItems(coaches.length)}</rowItems><colFields count="1"><field x="${columnFieldIndex}"/></colFields><colItems count="${columns.length+1}">${axisItems(columns.length)}</colItems><dataFields count="1"><dataField name="計數 - 簽到時間" fld="${dataFieldIndex}" subtotal="count" baseField="0" baseItem="0"/></dataFields><pivotTableStyleInfo name="PivotStyleMedium4" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/></pivotTableDefinition>`));
  const rel=(id,type,target)=>`<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;
  write('xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels',xml(`<Relationships xmlns="${P}">${rel('rId1','pivotCacheRecords','pivotCacheRecords1.xml')}</Relationships>`));
  write('xl/pivotTables/_rels/pivotTable1.xml.rels',xml(`<Relationships xmlns="${P}">${rel('rId1','pivotCacheDefinition','../pivotCache/pivotCacheDefinition1.xml')}</Relationships>`));
  write('xl/worksheets/_rels/sheet2.xml.rels',xml(`<Relationships xmlns="${P}">${rel('rIdFR01Pivot','pivotTable','../pivotTables/pivotTable1.xml')}</Relationships>`));
  write('xl/worksheets/sheet2.xml',read('xl/worksheets/sheet2.xml').replace('</worksheet>','<pivotParts count="1"><pivotPart r:id="rIdFR01Pivot"/></pivotParts></worksheet>'));
  write('xl/_rels/workbook.xml.rels',read('xl/_rels/workbook.xml.rels').replace('</Relationships>',`${rel('rIdFR01Cache','pivotCacheDefinition','pivotCache/pivotCacheDefinition1.xml')}</Relationships>`));
  write('xl/workbook.xml',read('xl/workbook.xml').replace('</workbook>','<pivotCaches><pivotCache cacheId="0" r:id="rIdFR01Cache"/></pivotCaches></workbook>'));
  const types=['pivotTables/pivotTable1.xml','pivotCache/pivotCacheDefinition1.xml','pivotCache/pivotCacheRecords1.xml'];
  const contentTypes=['pivotTable','pivotCacheDefinition','pivotCacheRecords'];
  write('[Content_Types].xml',read('[Content_Types].xml').replace('</Types>',types.map((name,i)=>`<Override PartName="/xl/${name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${contentTypes[i]}+xml"/>`).join('')+'</Types>'));
  if (Number.isInteger(dateFieldIndex) && Number.isInteger(noteFieldIndex)) {
    // SheetJS CE writes values and number formats. Add the small presentation
    // contract directly to OOXML instead of adding another spreadsheet library.
    const styles=read('xl/styles.xml'),match=styles.match(/<cellXfs count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);
    if(!match)throw new Error('SESSION_REPORT_STYLES_MISSING');
    const dateStyle=Number(match[1]),noteStyle=dateStyle+1;
    const dateXf='<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>';
    const noteXf='<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>';
    write('xl/styles.xml',styles.replace(match[0],`<cellXfs count="${dateStyle+2}">${match[2]}${dateXf}${noteXf}</cellXfs>`));
    const letter=index=>XLSX.utils.encode_col(index);
    let sheet=read('xl/worksheets/sheet1.xml');
    for(const [index,style] of [[dateFieldIndex,dateStyle],[noteFieldIndex,noteStyle]]) {
      const pattern=new RegExp(`<c r="${letter(index)}(\\d+)"([^>]*)(/?>)`,'g');
      sheet=sheet.replace(pattern,(whole,row,attributes,end)=>Number(row)<2?whole:`<c r="${letter(index)}${row}"${attributes.replace(/\s+s="\d+"/g,'')} s="${style}"${end}`);
    }
    sheet=sheet.replace(/<row r="(\d+)"([^>]*)>/g,(whole,row,attributes)=>{
      if(Number(row)<2)return whole;
      const lines=String(records[Number(row)-2]?.[noteFieldIndex]||'').split('\n');
      const height=Math.min(409,Math.max(30,lines.reduce((sum,line)=>sum+Math.max(1,Math.ceil([...line].length/55)),0)*16));
      return `<row r="${row}"${attributes.replace(/\s+(?:ht|customHeight)="[^"]*"/g,'')} ht="${height}" customHeight="1">`;
    });
    write('xl/worksheets/sheet1.xml',sheet);
  }
  return CFB.write(archive,{type:'array',fileType:'zip'});
}
