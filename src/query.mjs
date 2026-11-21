import esquery from 'esquery'
import ts from 'typescript-ts6'

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.TrueKeyword,
])

const kindNameCache = new Map()
for (const [key, value] of Object.entries(ts.SyntaxKind)) {
  if (typeof value === 'number' && !kindNameCache.has(value)) {
    kindNameCache.set(value, key)
  }
}

const propertiesCache = new WeakMap()

function syntaxKindName(kind) {
  return kindNameCache.get(kind) ?? ts.SyntaxKind[kind] ?? ''
}

function getProperties(node, sourceFile) {
  let props = propertiesCache.get(node)
  if (props) return props

  const text =
    typeof node.text === 'string'
      ? node.text
      : node.pos >= 0
        ? node.getText(sourceFile)
        : ''
  props = {
    kindName: syntaxKindName(node.kind),
    text,
  }
  if (node.kind === ts.SyntaxKind.Identifier) {
    props.name = typeof node.name === 'string' ? node.name : text
  }
  if (LITERAL_KINDS.has(node.kind)) {
    switch (node.kind) {
      case ts.SyntaxKind.TrueKeyword:
        props.value = true
        break
      case ts.SyntaxKind.FalseKeyword:
        props.value = false
        break
      case ts.SyntaxKind.NullKeyword:
        props.value = null
        break
      case ts.SyntaxKind.NumericLiteral:
        props.value = Number(text)
        break
      case ts.SyntaxKind.RegularExpressionLiteral:
        props.value = new RegExp(text)
        break
      default:
        props.value = text
        break
    }
  }
  propertiesCache.set(node, props)
  return props
}

function getPath(node, path, sourceFile) {
  const keys = path.split('.')
  let current = node
  for (const key of keys) {
    if (current == null) return undefined
    if (typeof current === 'object' && 'kind' in current) {
      const props = getProperties(current, sourceFile)
      if (key in current && current[key] !== undefined) {
        current = current[key]
      } else if (key in props) {
        current = props[key]
      } else {
        return undefined
      }
    } else {
      current = current[key]
    }
  }
  return current
}

function getSiblings(node, ancestors) {
  const parent = ancestors[0]
  if (!parent) return []
  const list = []
  parent.forEachChild((child) => {
    list.push(child)
  })
  return list
}

function matchAttribute(node, selector, sourceFile) {
  const obj = getPath(node, selector.name, sourceFile)
  if (obj === undefined) return false
  if (selector.operator == null) return obj != null
  if (!selector.value) return false
  const { type, value } = selector.value
  switch (selector.operator) {
    case '=':
      if (type === 'regexp') return typeof obj === 'string' && value.test(obj)
      if (type === 'literal') return `${value}` === `${obj}`
      if (type === 'type') return value === typeof obj
      return false
    case '!=':
      if (type === 'regexp') return typeof obj === 'string' && !value.test(obj)
      if (type === 'literal') return `${value}` !== `${obj}`
      if (type === 'type') return value !== typeof obj
      return false
    case '<=':
      return obj <= value
    case '<':
      return obj < value
    case '>=':
      return obj >= value
    case '>':
      return obj > value
    default:
      return false
  }
}

function matchClass(node, selector) {
  const name = selector.name.toLowerCase()
  switch (name) {
    case 'statement':
      return ts.isStatement(node)
    case 'expression':
      return ts.isExpression(node)
    case 'declaration':
      return (
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node)
      )
    case 'function':
      return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      )
    case 'pattern':
      return ts.isBindingName(node)
    default:
      return false
  }
}

function matches(node, selector, ancestors, sourceFile) {
  if (!selector) return true
  switch (selector.type) {
    case 'wildcard':
      return true
    case 'identifier':
      return getProperties(node, sourceFile).kindName.toLowerCase() === selector.value.toLowerCase()
    case 'attribute':
      return matchAttribute(node, selector, sourceFile)
    case 'compound':
      return selector.selectors.every((sub) => matches(node, sub, ancestors, sourceFile))
    case 'matches':
      return selector.selectors.some((sub) => matches(node, sub, ancestors, sourceFile))
    case 'not':
      return !selector.selectors.some((sub) => matches(node, sub, ancestors, sourceFile))
    case 'has': {
      let found = false
      const visit = (child, childAncestors) => {
        if (found) return
        if (selector.selectors.some((sub) => matches(child, sub, childAncestors, sourceFile))) {
          found = true
          return
        }
        childAncestors.unshift(child)
        child.forEachChild((next) => visit(next, childAncestors))
        childAncestors.shift()
      }
      node.forEachChild((child) => visit(child, [node, ...ancestors]))
      return found
    }
    case 'descendant':
      if (!matches(node, selector.right, ancestors, sourceFile)) return false
      for (let i = 0; i < ancestors.length; i++) {
        if (matches(ancestors[i], selector.left, ancestors.slice(i + 1), sourceFile)) return true
      }
      return false
    case 'child':
      return (
        ancestors.length > 0 &&
        matches(node, selector.right, ancestors, sourceFile) &&
        matches(ancestors[0], selector.left, ancestors.slice(1), sourceFile)
      )
    case 'field': {
      const parent = ancestors[0]
      if (!parent) return false
      const target = getPath(parent, selector.name, sourceFile)
      if (Array.isArray(target)) return target.includes(node)
      return target === node
    }
    case 'adjacent': {
      if (!matches(node, selector.right, ancestors, sourceFile)) return false
      const siblings = getSiblings(node, ancestors)
      const index = siblings.indexOf(node)
      return index > 0 && matches(siblings[index - 1], selector.left, ancestors, sourceFile)
    }
    case 'sibling': {
      if (!matches(node, selector.right, ancestors, sourceFile)) return false
      const siblings = getSiblings(node, ancestors)
      const index = siblings.indexOf(node)
      for (let i = 0; i < index; i++) {
        if (matches(siblings[i], selector.left, ancestors, sourceFile)) return true
      }
      return false
    }
    case 'nth-child': {
      const siblings = getSiblings(node, ancestors)
      return siblings.indexOf(node) === selector.index.value - 1
    }
    case 'nth-last-child': {
      const siblings = getSiblings(node, ancestors)
      const idx = siblings.indexOf(node)
      return idx !== -1 && siblings.length - idx === selector.index.value
    }
    case 'class':
      return matchClass(node, selector)
    case 'type':
      return false
    default:
      throw new SyntaxError(`Unsupported AST selector type: ${selector.type}`)
  }
}

export function queryAst(sourceFile, selectorText) {
  const parsed = esquery.parse(selectorText)
  const results = []
  const ancestors = []
  function visit(node) {
    if (matches(node, parsed, ancestors, sourceFile)) {
      results.push(node)
    }
    ancestors.unshift(node)
    node.forEachChild(visit)
    ancestors.shift()
  }
  visit(sourceFile)
  return results
}
