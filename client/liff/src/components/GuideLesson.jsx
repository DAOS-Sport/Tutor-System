import React, { useState } from "react";
export default function GuideLesson({ lesson }) {
  const [index, setIndex] = useState(0);
  const steps = lesson.steps;
  return (
    <details
      data-guide-lesson={lesson.id}
      className="rounded-xl border border-gray-200 bg-gray-50 p-4"
    >
      <summary className="min-h-11 cursor-pointer text-sm font-bold text-brand-primary">
        {lesson.title}
        <span className="mt-1 block text-xs font-normal text-gray-600">
          {lesson.entry}
        </span>
      </summary>
      <div className="mt-3 space-y-4 text-sm leading-6 text-gray-800">
        <section
          aria-label={`${lesson.title}路引指南`}
          className="min-w-0 break-words rounded-lg border border-gray-300 bg-gray-100 p-3"
        >
          <h3 className="mb-2 text-sm font-bold text-gray-700">路引指南</h3>
          <p className="mb-2 text-xs text-gray-600">
            從這裡開始：{lesson.entry}
          </p>
          <div aria-live="polite" aria-atomic="true">
            <p className="text-xs text-gray-500">
              步驟 {index + 1}／{steps.length}
            </p>
            <p className="mt-2">{steps[index]}</p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => setIndex((i) => i - 1)}
              className="min-h-11 flex-1 rounded-lg border border-gray-300 bg-white px-3 disabled:opacity-40"
            >
              上一步
            </button>
            {index < steps.length - 1 ? (
              <button
                type="button"
                onClick={() => setIndex((i) => i + 1)}
                className="min-h-11 flex-1 rounded-lg bg-brand-primary px-3 text-white"
              >
                下一步
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIndex(0)}
                className="min-h-11 flex-1 rounded-lg bg-brand-primary px-3 text-white"
              >
                重新看一次
              </button>
            )}
          </div>
        </section>
        <details className="rounded-lg border border-gray-200 bg-white p-3">
          <summary className="min-h-11 cursor-pointer text-xs font-bold text-brand-primary">
            查看全部步驟
          </summary>
          <ol className="list-decimal space-y-2 pl-5">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </details>
        <aside className="rounded-lg border border-gray-200 bg-white p-3">
          <h3 className="text-xs font-bold text-brand-primary">
            小提示與操作限制
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-600">
            {lesson.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </aside>
      </div>
    </details>
  );
}
