import { cn } from "cn"
import { LuLoaderCircle as Loader2Icon } from "react-icons/lu"

function Spinner({
  className,
  ...props
}) {
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
