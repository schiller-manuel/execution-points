// To Vite, each query string names a module of its own, so each of these evaluates the runtime's
// source again. To TypeScript they are all the runtime.
declare module '*/runtime.mjs?copy=0' {
  export * from 'execution-points-prototype'
}
declare module '*/runtime.mjs?copy=1' {
  export * from 'execution-points-prototype'
}
declare module '*/runtime.mjs?copy=2' {
  export * from 'execution-points-prototype'
}
