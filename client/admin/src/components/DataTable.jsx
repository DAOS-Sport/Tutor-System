import React from 'react';

/**
 * 通用 DataTable
 * columns: [{ key, label, render?(row, idx), className? }]
 * rows:    [obj...]
 * rowKey:  (row, idx) => string
 */
export default function DataTable({ columns, rows, rowKey, empty = '目前沒有資料', className = '', onRowClick }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-500">
        {empty}
      </div>
    );
  }
  return (
    <div className={`overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm ${className}`}>
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-600 ${c.className || ''}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row, idx) => (
            <tr
              key={rowKey ? rowKey(row, idx) : idx}
              className={`hover:bg-gray-50 ${onRowClick ? 'cursor-pointer' : ''}`}
              onClick={onRowClick ? () => onRowClick(row, idx) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-4 py-3 align-middle text-gray-800 ${c.className || ''}`}>
                  {c.render ? c.render(row, idx) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
