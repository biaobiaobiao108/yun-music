import { HttpContext, type ContextOptions } from './context'

export type RouteHandler = (
  ctx: HttpContext
) => Response | null | void | Promise<Response | null | void>

export type Middleware = (
  ctx: HttpContext,
  next: () => Promise<Response>
) => Promise<Response>

interface RouteEntry {
  method: string // 'GET' | 'POST' | ... | '*'
  pattern: string
  isPrefix: boolean
  handler: RouteHandler
  order: number
}

interface MiddlewareEntry {
  prefix: string
  middleware: Middleware
}

export class Router {
  private routes: RouteEntry[] = []
  private middlewares: MiddlewareEntry[] = []
  private nextRouteOrder = 0
  private routeIndexDirty = true
  private readonly routesByMethod = new Map<string, RouteEntry[]>()
  private readonly routeCandidatesByMethod = new Map<string, RouteEntry[]>()
  private notFoundHandler: RouteHandler = (ctx) =>
    ctx.fail(404, '接口不存在', { path: ctx.pathname })

  /** 注册全局或带前缀的中间件 */
  use(middleware: Middleware): this
  use(prefix: string, middleware: Middleware): this
  use(prefixOrMiddleware: string | Middleware, maybeMiddleware?: Middleware): this {
    if (typeof prefixOrMiddleware === 'string') {
      let prefix = prefixOrMiddleware.replace(/\*+$/, '')
      if (prefix.endsWith('/') && prefix !== '/') {
        prefix = prefix.slice(0, -1)
      }
      if (maybeMiddleware) {
        this.middlewares.push({ prefix, middleware: maybeMiddleware })
      }
    } else {
      this.middlewares.push({ prefix: '', middleware: prefixOrMiddleware })
    }
    return this
  }

  /** 挂载子路由 */
  mount(prefix: string, subRouter: Router): this {
    let normalizedPrefix = prefix.replace(/\/+$/, '')
    if (normalizedPrefix === '/') normalizedPrefix = ''

    // 复制子路由中间件并附上前缀
    for (const mw of subRouter.middlewares) {
      const combined = `${normalizedPrefix}${mw.prefix}`
      this.middlewares.push({ prefix: combined, middleware: mw.middleware })
    }

    // 复制子路由规则并附上前缀
    for (const route of subRouter.routes) {
      const combined = route.pattern === '/'
        ? normalizedPrefix
        : `${normalizedPrefix}${route.pattern}`
      this.routes.push({
        ...route,
        pattern: combined,
        order: this.nextRouteOrder++,
      })
    }
    this.routeIndexDirty = true
    this.routeCandidatesByMethod.clear()
    return this
  }

  /** 注册通用路由 */
  add(method: string, path: string, handler: RouteHandler): this {
    const isPrefix = path.endsWith('/*') || path.endsWith('*')
    const pattern = isPrefix ? path.replace(/\*+$/, '').replace(/\/+$/, '') : path
    this.routes.push({
      method: method.toUpperCase(),
      pattern: pattern || '/',
      isPrefix,
      handler,
      order: this.nextRouteOrder++,
    })
    this.routeIndexDirty = true
    this.routeCandidatesByMethod.clear()
    return this
  }

  get(path: string, handler: RouteHandler): this {
    return this.add('GET', path, handler)
  }

  post(path: string, handler: RouteHandler): this {
    return this.add('POST', path, handler)
  }

  put(path: string, handler: RouteHandler): this {
    return this.add('PUT', path, handler)
  }

  delete(path: string, handler: RouteHandler): this {
    return this.add('DELETE', path, handler)
  }

  options(path: string, handler: RouteHandler): this {
    return this.add('OPTIONS', path, handler)
  }

  all(path: string, handler: RouteHandler): this {
    return this.add('*', path, handler)
  }

  setNotFound(handler: RouteHandler): this {
    this.notFoundHandler = handler
    return this
  }

  /** 路由匹配判断 */
  private matchRoute(route: RouteEntry, method: string, pathname: string): boolean {
    if (route.method !== '*' && route.method !== method) return false
    if (route.isPrefix) {
      if (route.pattern === '' || route.pattern === '/') return true
      return pathname === route.pattern || pathname.startsWith(`${route.pattern}/`)
    }
    return pathname === route.pattern
  }

  /**
   * 按请求方法缓存路由候选，避免每个请求都遍历其他方法的规则。
   * 通配方法路由与具体方法路由按注册顺序归并，保持原有匹配语义。
   */
  private getRouteCandidates(method: string): RouteEntry[] {
    if (this.routeIndexDirty) {
      this.routesByMethod.clear()
      for (const route of this.routes) {
        const entries = this.routesByMethod.get(route.method)
        if (entries) entries.push(route)
        else this.routesByMethod.set(route.method, [route])
      }
      this.routeIndexDirty = false
      this.routeCandidatesByMethod.clear()
    }

    const cached = this.routeCandidatesByMethod.get(method)
    if (cached) return cached

    const methodRoutes = this.routesByMethod.get(method) || []
    const wildcardRoutes = this.routesByMethod.get('*') || []
    if (wildcardRoutes.length === 0) {
      this.routeCandidatesByMethod.set(method, methodRoutes)
      return methodRoutes
    }
    if (methodRoutes.length === 0) {
      this.routeCandidatesByMethod.set(method, wildcardRoutes)
      return wildcardRoutes
    }

    const merged: RouteEntry[] = []
    let methodIndex = 0
    let wildcardIndex = 0
    while (methodIndex < methodRoutes.length || wildcardIndex < wildcardRoutes.length) {
      const methodRoute = methodRoutes[methodIndex]
      const wildcardRoute = wildcardRoutes[wildcardIndex]
      if (!wildcardRoute || (methodRoute && methodRoute.order < wildcardRoute.order)) {
        merged.push(methodRoute)
        methodIndex++
      } else {
        merged.push(wildcardRoute)
        wildcardIndex++
      }
    }

    this.routeCandidatesByMethod.set(method, merged)
    return merged
  }

  /** 处理单个 Request 并返回 Response */
  async handle(request: Request, options?: ContextOptions): Promise<Response> {
    const ctx = new HttpContext(request, options)

    // 收集适用于当前路径的中间件
    const applicableMiddlewares = this.middlewares.filter(mw => {
      if (!mw.prefix || mw.prefix === '/') return true
      return ctx.pathname === mw.prefix || ctx.pathname.startsWith(`${mw.prefix}/`)
    })

    // 执行中间件洋葱模型
    let index = -1
    const dispatch = async (i: number): Promise<Response> => {
      if (i <= index) throw new Error('next() called multiple times')
      index = i
      const entry = applicableMiddlewares[i]
      if (entry) {
        return await entry.middleware(ctx, () => dispatch(i + 1))
      }

      // 所有中间件执行完毕，匹配路由
      for (const route of this.getRouteCandidates(ctx.method)) {
        if (this.matchRoute(route, ctx.method, ctx.pathname)) {
          const res = await route.handler(ctx)
          if (res instanceof Response) return res
        }
      }

      // 未命中路由，调用 404 或回退处理器
      const fallback = await this.notFoundHandler(ctx)
      if (fallback === null) return null as any
      if (fallback instanceof Response) return fallback
      return ctx.fail(404, '接口不存在')
    }

    try {
      return await dispatch(0)
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[Router Error] ${ctx.requestId} ${ctx.method} ${ctx.pathname}:`, err)
      return ctx.fail(500, '服务器内部错误，请稍后重试', {
        requestId: ctx.requestId,
        detail: process.env.NODE_ENV !== 'production' ? detail : undefined,
      })
    }
  }
}
